// A small dialog that asks for some text.

// Cancel buttons aren't submit buttons: pressing Enter in a form "clicks" its
// first submit button, and that should be OK, not Cancel.
for (const button of document.querySelectorAll<HTMLButtonElement>("dialog [data-cancel]")) {
  button.addEventListener("click", () => button.closest("dialog")!.close("cancel"));
}

const dialog = () => document.getElementById("prompt") as HTMLDialogElement;

/** Resolves to the text entered, or null if cancelled. */
export function promptText(label: string, value: string, options: { multiline?: boolean } = {}): Promise<string | null> {
  const promptDialog = dialog();
  const input = promptDialog.querySelector<HTMLInputElement>("#prompt-input")!;
  const area = promptDialog.querySelector<HTMLTextAreaElement>("#prompt-area")!;
  const field = options.multiline ? area : input;
  input.hidden = !!options.multiline;
  area.hidden = !options.multiline;

  promptDialog.querySelector("#prompt-label")!.textContent = label;
  promptDialog.querySelector("#prompt-label")!.setAttribute("for", field.id);
  field.value = value;
  promptDialog.returnValue = "";
  promptDialog.showModal();
  field.focus();
  if (!options.multiline) input.select();

  return new Promise((resolve) => {
    promptDialog.addEventListener(
      "close",
      () => resolve(promptDialog.returnValue === "ok" ? field.value.trim() : null),
      { once: true },
    );
  });
}

export function isPromptOpen(): boolean {
  return dialog().open;
}
