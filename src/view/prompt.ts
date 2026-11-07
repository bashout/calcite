import { App, Modal, Setting } from "obsidian";

/** window.prompt/confirm are unreliable under Electron; use real modals. */

export function promptText(app: App, title: string, def: string): Promise<string | null> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    modal.titleEl.setText(title);
    let value = def;
    new Setting(modal.contentEl).addText((t) => {
      t.setValue(def).onChange((v) => (value = v));
      t.inputEl.focus();
    });
    new Setting(modal.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => {
        modal.close();
        resolve(null);
      }))
      .addButton((b) => b.setButtonText("OK").setCta().onClick(() => {
        modal.close();
        resolve(value.trim() || null);
      }));
    modal.open();
  });
}

export function confirmDialog(app: App, title: string, message: string): Promise<boolean> {
  return new Promise((resolve) => {
    const modal = new Modal(app);
    modal.titleEl.setText(title);
    modal.contentEl.createEl("p", { text: message });
    new Setting(modal.contentEl)
      .addButton((b) => b.setButtonText("Cancel").onClick(() => {
        modal.close();
        resolve(false);
      }))
      .addButton((b) => b.setButtonText("Delete").setWarning().onClick(() => {
        modal.close();
        resolve(true);
      }));
    modal.open();
  });
}
