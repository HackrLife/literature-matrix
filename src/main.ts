import {
	App,
	Component,
	ItemView,
	MarkdownRenderer,
	Modal,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting,
	SettingDefinitionItem,
	TFile,
	WorkspaceLeaf,
	debounce,
	getAllTags,
	moment,
	normalizePath,
	setIcon,
} from "obsidian";

const VIEW_TYPE_MATRIX = "literature-matrix-view";
/** Frontmatter key that marks an exported matrix, so exports never show up as papers. */
const EXPORT_MARKER = "literature-matrix-export";

interface LiteratureMatrixSettings {
	folder: string;
	tag: string;
	sections: string;
	properties: string;
	renderMarkdown: boolean;
}

const DEFAULT_SETTINGS: LiteratureMatrixSettings = {
	folder: "",
	tag: "",
	sections: "Method|Methods|Methodology, Data|Dataset|Sample, Findings|Results, Gaps|Limitations",
	properties: "authors, year",
	renderMarkdown: true,
};

/** A matrix column built from a heading, with the alternative heading names that fill it. */
interface SectionColumn {
	label: string;
	names: string[];
}

interface PaperRow {
	file: TFile;
	title: string;
	properties: Record<string, string>;
	sections: Record<string, SectionMatch | null>;
}

interface SectionMatch {
	heading: string;
	text: string;
}

type SortKey = { kind: "title" } | { kind: "property"; key: string } | { kind: "gaps" };

function normaliseHeading(value: string): string {
	return value
		.toLowerCase()
		.replace(/[*_`#:]+/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

function parseColumns(raw: string): SectionColumn[] {
	return raw
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0)
		.map((part) => {
			const names = part
				.split("|")
				.map((name) => name.trim())
				.filter((name) => name.length > 0);
			return { label: names[0] ?? part, names: names.map(normaliseHeading) };
		});
}

function parseList(raw: string): string[] {
	return raw
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part.length > 0);
}

function formatValue(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (Array.isArray(value)) return value.map((item) => formatValue(item)).join(", ");
	if (typeof value === "object") return JSON.stringify(value);
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return "";
}

/** A section counts as filled when its heading exists and has text under it. */
function isFilled(row: PaperRow, column: SectionColumn): boolean {
	const match = row.sections[column.label];
	return match !== null && match !== undefined && match.text.length > 0;
}

function normaliseTag(tag: string): string {
	const trimmed = tag.trim().toLowerCase();
	if (trimmed.length === 0) return "";
	return trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
}

export default class LiteratureMatrixPlugin extends Plugin {
	settings: LiteratureMatrixSettings = { ...DEFAULT_SETTINGS };

	async onload(): Promise<void> {
		await this.loadSettings();

		this.registerView(VIEW_TYPE_MATRIX, (leaf) => new LiteratureMatrixView(leaf, this));

		this.addRibbonIcon("table-2", "Open literature matrix", () => {
			void this.activateView();
		});

		this.addCommand({
			id: "open-matrix",
			name: "Open matrix",
			callback: () => {
				void this.activateView();
			},
		});

		this.addCommand({
			id: "create-literature-note",
			name: "Create literature note",
			callback: () => {
				new NewPaperModal(this.app, this).open();
			},
		});

		this.addCommand({
			id: "export-matrix-to-note",
			name: "Export matrix to a note",
			callback: () => {
				void this.exportToNote();
			},
		});

		this.addCommand({
			id: "copy-matrix-as-csv",
			name: "Copy matrix as CSV",
			callback: () => {
				void this.copyAsCsv();
			},
		});

		this.addSettingTab(new LiteratureMatrixSettingTab(this.app, this));

		const refreshSoon = debounce(() => this.refreshViews(), 600, true);
		this.registerEvent(this.app.metadataCache.on("changed", () => refreshSoon()));
		this.registerEvent(this.app.vault.on("delete", () => refreshSoon()));
		this.registerEvent(this.app.vault.on("rename", () => refreshSoon()));
	}

	async loadSettings(): Promise<void> {
		const stored = (await this.loadData()) as Partial<LiteratureMatrixSettings> | null;
		this.settings = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
		this.refreshViews();
	}

	refreshViews(): void {
		for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_MATRIX)) {
			const view = leaf.view;
			if (view instanceof LiteratureMatrixView) {
				void view.refresh();
			}
		}
	}

	async activateView(): Promise<void> {
		const { workspace } = this.app;
		let leaf: WorkspaceLeaf | null = workspace.getLeavesOfType(VIEW_TYPE_MATRIX)[0] ?? null;
		if (!leaf) {
			leaf = workspace.getLeaf("tab");
			await leaf.setViewState({ type: VIEW_TYPE_MATRIX, active: true });
		}
		await workspace.revealLeaf(leaf);
	}

	get columns(): SectionColumn[] {
		return parseColumns(this.settings.sections);
	}

	get propertyKeys(): string[] {
		return parseList(this.settings.properties);
	}

	/** Notes in scope: inside the folder (if set) and carrying the tag (if set). */
	getPaperFiles(): TFile[] {
		const folder = normalizePath(this.settings.folder.trim());
		const tag = normaliseTag(this.settings.tag);
		const inRoot = folder === "/" || folder === "" || folder === ".";

		return this.app.vault.getMarkdownFiles().filter((file) => {
			if (!inRoot && !(file.path === folder || file.path.startsWith(`${folder}/`))) return false;
			const cache = this.app.metadataCache.getFileCache(file);
			if (cache?.frontmatter?.[EXPORT_MARKER] !== undefined) return false;
			if (tag.length === 0) return true;
			if (!cache) return false;
			const tags = (getAllTags(cache) ?? []).map((t) => t.toLowerCase());
			return tags.some((t) => t === tag || t.startsWith(`${tag}/`));
		});
	}

	async buildRows(): Promise<PaperRow[]> {
		const columns = this.columns;
		const propertyKeys = this.propertyKeys;
		const rows: PaperRow[] = [];

		for (const file of this.getPaperFiles()) {
			const cache = this.app.metadataCache.getFileCache(file);
			const content = await this.app.vault.cachedRead(file);
			const headings = cache?.headings ?? [];
			const frontmatter = (cache?.frontmatter ?? {}) as Record<string, unknown>;

			const properties: Record<string, string> = {};
			for (const key of propertyKeys) {
				properties[key] = formatValue(frontmatter[key]);
			}

			const sections: Record<string, SectionMatch | null> = {};
			for (const column of columns) {
				sections[column.label] = null;
			}

			headings.forEach((heading, index) => {
				const name = normaliseHeading(heading.heading);
				const column = columns.find(
					(col) => sections[col.label] === null && col.names.includes(name),
				);
				if (!column) return;

				let end = content.length;
				for (let next = index + 1; next < headings.length; next++) {
					const candidate = headings[next];
					if (candidate && candidate.level <= heading.level) {
						end = candidate.position.start.offset;
						break;
					}
				}
				const text = content.slice(heading.position.end.offset, end).trim();
				sections[column.label] = { heading: heading.heading, text };
			});

			const title = formatValue(frontmatter["title"]) || file.basename;
			rows.push({ file, title, properties, sections });
		}

		return rows;
	}

	async exportToNote(): Promise<void> {
		const rows = await this.buildRows();
		if (rows.length === 0) {
			new Notice("No literature notes found. Set a folder or tag in the plugin settings.");
			return;
		}
		const date = moment().format("YYYY-MM-DD");
		const markdown = `---\n${EXPORT_MARKER}: ${date}\n---\n\n${toMarkdownTable(rows, this.columns, this.propertyKeys)}`;
		const folder = this.settings.folder.trim();
		const base = `Literature matrix ${date}`;
		let path = normalizePath(folder ? `${folder}/${base}.md` : `${base}.md`);
		let counter = 2;
		while (this.app.vault.getAbstractFileByPath(path)) {
			path = normalizePath(folder ? `${folder}/${base} ${counter}.md` : `${base} ${counter}.md`);
			counter++;
		}
		const file = await this.app.vault.create(path, markdown);
		await this.app.workspace.getLeaf("tab").openFile(file);
		new Notice(`Matrix exported to ${file.basename}`);
	}

	async copyAsCsv(): Promise<void> {
		const rows = await this.buildRows();
		if (rows.length === 0) {
			new Notice("No literature notes found. Set a folder or tag in the plugin settings.");
			return;
		}
		await navigator.clipboard.writeText(toCsv(rows, this.columns, this.propertyKeys));
		new Notice(`Copied ${rows.length} rows as CSV`);
	}

	/** Adds a missing section heading to the end of a note, then opens the note there. */
	async addSection(file: TFile, label: string): Promise<void> {
		await this.app.vault.process(file, (data) => `${data.replace(/\s+$/, "")}\n\n## ${label}\n\n`);
		await this.openAtHeading(file, label);
	}

	async openAtHeading(file: TFile, heading: string): Promise<void> {
		await this.app.workspace.openLinkText(`${file.path}#${heading}`, "", false);
	}
}

function cellText(text: string): string {
	return text
		.split(/\r?\n/)
		.map((line) => line.replace(/^#{1,6}\s+/, "").trim())
		.filter((line) => line.length > 0)
		.join("<br>")
		.replace(/\|/g, "\\|")
		.trim();
}

function toMarkdownTable(rows: PaperRow[], columns: SectionColumn[], propertyKeys: string[]): string {
	const header = ["Paper", ...propertyKeys, ...columns.map((c) => c.label)];
	const lines = [
		`| ${header.map(cellText).join(" | ")} |`,
		`| ${header.map(() => "---").join(" | ")} |`,
	];
	for (const row of rows) {
		const cells = [
			`[[${row.file.path.replace(/\.md$/, "")}\\|${row.title.replace(/\|/g, "")}]]`,
			...propertyKeys.map((key) => cellText(row.properties[key] ?? "")),
			...columns.map((col) => {
				const match = row.sections[col.label];
				return match ? cellText(match.text) || "—" : "**Missing**";
			}),
		];
		lines.push(`| ${cells.join(" | ")} |`);
	}
	return `${lines.join("\n")}\n`;
}

function csvField(value: string): string {
	return `"${value.replace(/"/g, '""')}"`;
}

function toCsv(rows: PaperRow[], columns: SectionColumn[], propertyKeys: string[]): string {
	const header = ["Paper", "Path", ...propertyKeys, ...columns.map((c) => c.label)];
	const lines = [header.map(csvField).join(",")];
	for (const row of rows) {
		lines.push(
			[
				row.title,
				row.file.path,
				...propertyKeys.map((key) => row.properties[key] ?? ""),
				...columns.map((col) => row.sections[col.label]?.text ?? ""),
			]
				.map(csvField)
				.join(","),
		);
	}
	return lines.join("\n");
}

class LiteratureMatrixView extends ItemView {
	private plugin: LiteratureMatrixPlugin;
	private renderScope: Component | null = null;
	private query = "";
	private gapsOnly = false;
	private sort: SortKey = { kind: "title" };
	private sortAscending = true;
	private rows: PaperRow[] = [];
	private tableHost: HTMLElement | null = null;
	private statsEl: HTMLElement | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: LiteratureMatrixPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_MATRIX;
	}

	getDisplayText(): string {
		return "Literature matrix";
	}

	getIcon(): string {
		return "table-2";
	}

	async onOpen(): Promise<void> {
		this.contentEl.empty();
		this.contentEl.addClass("lm-view");
		this.buildToolbar();
		this.tableHost = this.contentEl.createDiv({ cls: "lm-table-host" });
		await this.refresh();
	}

	async onClose(): Promise<void> {
		this.contentEl.empty();
	}

	private buildToolbar(): void {
		const bar = this.contentEl.createDiv({ cls: "lm-toolbar" });

		const titleBlock = bar.createDiv({ cls: "lm-title-block" });
		titleBlock.createDiv({ cls: "lm-title", text: "Literature matrix" });
		this.statsEl = titleBlock.createDiv({ cls: "lm-stats" });

		const controls = bar.createDiv({ cls: "lm-controls" });

		const search = controls.createEl("input", {
			cls: "lm-search",
			attr: { type: "search", placeholder: "Filter papers and sections", "aria-label": "Filter" },
		});
		search.addEventListener("input", () => {
			this.query = search.value.trim().toLowerCase();
			this.renderTable();
		});

		const gapsChip = controls.createEl("button", { cls: "lm-chip", text: "Gaps only" });
		gapsChip.setAttr("aria-pressed", "false");
		gapsChip.addEventListener("click", () => {
			this.gapsOnly = !this.gapsOnly;
			gapsChip.toggleClass("is-active", this.gapsOnly);
			gapsChip.setAttr("aria-pressed", String(this.gapsOnly));
			this.renderTable();
		});

		this.iconButton(controls, "plus", "New literature note", () => {
			new NewPaperModal(this.app, this.plugin).open();
		});
		this.iconButton(controls, "refresh-cw", "Refresh", () => {
			void this.refresh();
		});
		this.iconButton(controls, "clipboard-copy", "Copy as CSV", () => {
			void this.plugin.copyAsCsv();
		});
		this.iconButton(controls, "file-output", "Export to a note", () => {
			void this.plugin.exportToNote();
		});
	}

	private iconButton(parent: HTMLElement, icon: string, label: string, onClick: () => void): void {
		const button = parent.createEl("button", { cls: "lm-icon-button clickable-icon", attr: { "aria-label": label } });
		setIcon(button, icon);
		button.addEventListener("click", onClick);
	}

	async refresh(): Promise<void> {
		this.rows = await this.plugin.buildRows();
		this.renderTable();
	}

	private visibleRows(): PaperRow[] {
		const columns = this.plugin.columns;
		let rows = this.rows.slice();

		if (this.gapsOnly) {
			rows = rows.filter((row) => columns.some((col) => !isFilled(row, col)));
		}

		if (this.query.length > 0) {
			const q = this.query;
			rows = rows.filter((row) => {
				if (row.title.toLowerCase().includes(q)) return true;
				if (Object.values(row.properties).some((v) => v.toLowerCase().includes(q))) return true;
				return Object.values(row.sections).some((s) => s?.text.toLowerCase().includes(q) ?? false);
			});
		}

		const direction = this.sortAscending ? 1 : -1;
		const sort = this.sort;
		rows.sort((a, b) => {
			if (sort.kind === "property") {
				const av = a.properties[sort.key] ?? "";
				const bv = b.properties[sort.key] ?? "";
				return av.localeCompare(bv, undefined, { numeric: true }) * direction;
			}
			if (sort.kind === "gaps") {
				const gaps = (row: PaperRow) => columns.filter((col) => !isFilled(row, col)).length;
				return (gaps(a) - gaps(b)) * direction;
			}
			return a.title.localeCompare(b.title, undefined, { numeric: true }) * direction;
		});

		return rows;
	}

	private setSort(next: SortKey): void {
		const same = JSON.stringify(next) === JSON.stringify(this.sort);
		this.sortAscending = same ? !this.sortAscending : true;
		this.sort = next;
		this.renderTable();
	}

	private sortHeader(cell: HTMLElement, label: string, key: SortKey): void {
		const button = cell.createEl("button", { cls: "lm-sort", text: label });
		const active = JSON.stringify(key) === JSON.stringify(this.sort);
		if (active) {
			const arrow = button.createSpan({ cls: "lm-sort-arrow" });
			setIcon(arrow, this.sortAscending ? "arrow-up" : "arrow-down");
		}
		button.addEventListener("click", () => this.setSort(key));
	}

	private renderTable(): void {
		const host = this.tableHost;
		if (!host) return;

		if (this.renderScope) {
			this.removeChild(this.renderScope);
		}
		this.renderScope = new Component();
		this.addChild(this.renderScope);
		const scope = this.renderScope;

		host.empty();
		const columns = this.plugin.columns;
		const propertyKeys = this.plugin.propertyKeys;
		const total = this.rows.length;
		const missing = this.rows.reduce(
			(sum, row) => sum + columns.filter((col) => !isFilled(row, col)).length,
			0,
		);

		this.statsEl?.setText(
			total === 0
				? "No papers yet"
				: `${total} ${total === 1 ? "paper" : "papers"} · ${columns.length} sections · ${missing} missing`,
		);

		if (total === 0) {
			this.renderEmptyState(host);
			return;
		}

		const rows = this.visibleRows();
		const scroller = host.createDiv({ cls: "lm-scroller" });
		const table = scroller.createEl("table", { cls: "lm-table" });

		const head = table.createEl("thead").createEl("tr");
		this.sortHeader(head.createEl("th", { cls: "lm-paper-col" }), "Paper", { kind: "title" });
		for (const key of propertyKeys) {
			this.sortHeader(head.createEl("th", { cls: "lm-prop-col" }), key, { kind: "property", key });
		}
		for (const col of columns) {
			const th = head.createEl("th", { cls: "lm-section-col" });
			th.createDiv({ cls: "lm-col-label", text: col.label });
			const covered = this.rows.filter((row) => isFilled(row, col)).length;
			const meter = th.createDiv({ cls: "lm-coverage" });
			meter.createSpan({ text: `${covered} of ${total}` });
			const bar = meter.createDiv({ cls: "lm-coverage-bar" });
			const fill = bar.createDiv({ cls: "lm-coverage-fill" });
			fill.setCssProps({ "--lm-coverage": `${Math.round((covered / total) * 100)}%` });
		}

		const body = table.createEl("tbody");
		if (rows.length === 0) {
			const tr = body.createEl("tr");
			tr.createEl("td", {
				cls: "lm-no-match",
				text: "No papers match this filter.",
				attr: { colspan: String(1 + propertyKeys.length + columns.length) },
			});
		}

		for (const row of rows) {
			const tr = body.createEl("tr");

			const paperCell = tr.createEl("td", { cls: "lm-paper-col" });
			const link = paperCell.createEl("a", { cls: "lm-paper-link", text: row.title, href: "#" });
			link.addEventListener("click", (event) => {
				event.preventDefault();
				void this.app.workspace.openLinkText(row.file.path, "", false);
			});
			const gaps = columns.filter((col) => !isFilled(row, col)).length;
			paperCell.createDiv({
				cls: gaps === 0 ? "lm-badge is-complete" : "lm-badge",
				text: gaps === 0 ? "Complete" : `${gaps} missing`,
			});

			for (const key of propertyKeys) {
				tr.createEl("td", { cls: "lm-prop-col", text: row.properties[key] ?? "" });
			}

			for (const col of columns) {
				const td = tr.createEl("td", { cls: "lm-section-col" });
				const match = row.sections[col.label];
				if (!match) {
					const add = td.createEl("button", { cls: "lm-missing", attr: { "aria-label": `Add a ${col.label} section` } });
					const icon = add.createSpan({ cls: "lm-missing-icon" });
					setIcon(icon, "plus");
					add.createSpan({ text: "Add section" });
					add.addEventListener("click", () => {
						void this.plugin.addSection(row.file, col.label);
					});
					continue;
				}

				const cell = td.createDiv({ cls: "lm-cell", attr: { tabindex: "0", "aria-label": `Open ${col.label}` } });
				if (match.text.length === 0) {
					cell.addClass("is-empty");
					cell.setText("Empty. Select to write it.");
				} else if (this.plugin.settings.renderMarkdown) {
					void MarkdownRenderer.render(this.app, match.text, cell, row.file.path, scope);
				} else {
					cell.setText(match.text);
				}
				const open = (event: Event) => {
					const target = event.target;
					if (target instanceof HTMLElement && target.closest("a")) return;
					void this.plugin.openAtHeading(row.file, match.heading);
				};
				cell.addEventListener("click", open);
				cell.addEventListener("keydown", (event) => {
					if (event.key === "Enter") open(event);
				});
			}
		}
	}

	private renderEmptyState(host: HTMLElement): void {
		const empty = host.createDiv({ cls: "lm-empty" });
		const icon = empty.createDiv({ cls: "lm-empty-icon" });
		setIcon(icon, "table-2");
		empty.createDiv({ cls: "lm-empty-title", text: "No literature notes found" });
		const scope = [
			this.plugin.settings.folder ? `folder "${this.plugin.settings.folder}"` : "",
			this.plugin.settings.tag ? `tag ${normaliseTag(this.plugin.settings.tag)}` : "",
		]
			.filter(Boolean)
			.join(" and ");
		empty.createDiv({
			cls: "lm-empty-text",
			text: scope
				? `Nothing matches ${scope}. Check the plugin settings, or create your first literature note.`
				: "Choose a folder or tag in the plugin settings, or create your first literature note.",
		});
		const button = empty.createEl("button", { cls: "mod-cta", text: "Create literature note" });
		button.addEventListener("click", () => new NewPaperModal(this.app, this.plugin).open());
	}
}

class NewPaperModal extends Modal {
	private plugin: LiteratureMatrixPlugin;
	private title = "";
	private properties: Record<string, string> = {};

	constructor(app: App, plugin: LiteratureMatrixPlugin) {
		super(app);
		this.plugin = plugin;
	}

	onOpen(): void {
		this.setTitle("New literature note");
		const { contentEl } = this;

		new Setting(contentEl).setName("Title").addText((text) => {
			text.setPlaceholder("Paper title").onChange((value) => {
				this.title = value;
			});
			text.inputEl.addEventListener("keydown", (event) => {
				if (event.key === "Enter") void this.submit();
			});
			window.setTimeout(() => text.inputEl.focus(), 0);
		});

		for (const key of this.plugin.propertyKeys) {
			new Setting(contentEl).setName(key).addText((text) =>
				text.onChange((value) => {
					this.properties[key] = value;
				}),
			);
		}

		new Setting(contentEl).addButton((button) =>
			button
				.setButtonText("Create")
				.setCta()
				.onClick(() => {
					void this.submit();
				}),
		);
	}

	private async submit(): Promise<void> {
		const title = this.title.trim();
		if (title.length === 0) {
			new Notice("Give the paper a title first.");
			return;
		}
		const safeName = title.replace(/[\\/:*?"<>|#^[\]]/g, " ").replace(/\s+/g, " ").trim();
		const folder = this.plugin.settings.folder.trim();
		const path = normalizePath(folder ? `${folder}/${safeName}.md` : `${safeName}.md`);
		if (this.app.vault.getAbstractFileByPath(path)) {
			new Notice("A note with this title already exists.");
			return;
		}
		if (folder && !this.app.vault.getAbstractFileByPath(normalizePath(folder))) {
			await this.app.vault.createFolder(normalizePath(folder));
		}

		const lines = ["---", `title: ${JSON.stringify(title)}`];
		for (const key of this.plugin.propertyKeys) {
			const value = (this.properties[key] ?? "").trim();
			lines.push(`${key}: ${value ? JSON.stringify(value) : ""}`);
		}
		const tag = normaliseTag(this.plugin.settings.tag).replace(/^#/, "");
		if (tag) lines.push("tags:", `  - ${tag}`);
		lines.push("---", "");
		for (const column of this.plugin.columns) {
			lines.push(`## ${column.label}`, "", "");
		}

		const file = await this.app.vault.create(path, lines.join("\n"));
		await this.app.workspace.getLeaf("tab").openFile(file);
		this.close();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

class LiteratureMatrixSettingTab extends PluginSettingTab {
	private plugin: LiteratureMatrixPlugin;

	constructor(app: App, plugin: LiteratureMatrixPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	getSettingDefinitions(): SettingDefinitionItem[] {
		return [
			{
				type: "group",
				heading: "Which notes",
				items: [
					{
						name: "Folder",
						desc: "Literature notes live here, including subfolders. Leave empty for the whole vault.",
						control: { type: "folder", key: "folder", placeholder: "Example: Research/Papers", includeRoot: true },
					},
					{
						name: "Tag",
						desc: "Only include notes with this tag. Leave empty to include every note in the folder.",
						control: { type: "text", key: "tag", placeholder: "Example: #paper" },
					},
				],
			},
			{
				type: "group",
				heading: "Matrix columns",
				items: [
					{
						name: "Sections",
						desc: "Headings to show as columns, separated by commas. Use | for other names that fill the same column, such as Findings|Results.",
						control: { type: "textarea", key: "sections", rows: 3 },
					},
					{
						name: "Properties",
						desc: "Frontmatter properties to show next to each paper, separated by commas.",
						control: { type: "text", key: "properties", placeholder: "Example: authors, year, venue" },
					},
					{
						name: "Render Markdown in cells",
						desc: "Show links, lists and formatting. Turn off for plain text, which is faster in large vaults.",
						control: { type: "toggle", key: "renderMarkdown" },
					},
				],
			},
		];
	}

	getControlValue(key: string): unknown {
		return this.plugin.settings[key as keyof LiteratureMatrixSettings];
	}

	async setControlValue(key: string, value: unknown): Promise<void> {
		const settings = this.plugin.settings as unknown as Record<string, unknown>;
		settings[key] = value;
		await this.plugin.saveSettings();
	}
}
