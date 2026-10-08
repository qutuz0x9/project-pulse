import { App, Modal, Notice, Setting } from "obsidian";

/** Asks for a project name. Used by "New project" and "Mark current note as project". */
export class ProjectModal extends Modal {
	private name: string;

	constructor(
		app: App,
		private heading: string,
		initialName: string,
		private buttonText: string,
		private onSubmit: (name: string) => Promise<void>
	) {
		super(app);
		this.name = initialName;
	}

	onOpen(): void {
		const { contentEl } = this;
		this.setTitle(this.heading);

		new Setting(contentEl).setName("Project name").addText((text) => {
			text.setPlaceholder("e.g. Docker Study").setValue(this.name).onChange((v) => (this.name = v));
			text.inputEl.addEventListener("keydown", (e) => {
				if (e.key === "Enter") this.submit();
			});
			window.setTimeout(() => text.inputEl.select(), 0);
		});

		new Setting(contentEl).addButton((btn) =>
			btn
				.setButtonText(this.buttonText)
				.setCta()
				.onClick(() => this.submit())
		);
	}

	private async submit(): Promise<void> {
		const name = this.name.trim();
		if (!name) return void new Notice("Project name is required.");
		try {
			await this.onSubmit(name);
			this.close();
		} catch (e) {
			new Notice(e instanceof Error ? e.message : "Failed to save project.");
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
