/** Small keyboard-native address editor. Values are normalized before entering
 * the chip collection; discovery never overwrites addresses already edited. */
export class DestinationInput {
  #values: string[] = [];
  #revision = 0;
  #chips = document.createElement("div");
  #error = document.createElement("p");
  #suggestions = document.createElement("datalist");
  readonly input: HTMLInputElement;
  constructor(host: HTMLElement, id: string, label: string, placeholder: string, private normalize: (value: string) => string, private maximum = 5) {
    host.className = "destination-editor";
    const fieldLabel = document.createElement("label"); fieldLabel.htmlFor = id; fieldLabel.textContent = label;
    this.#chips.className = "destination-chips"; this.#chips.setAttribute("aria-label", `${label} selected`);
    this.input = document.createElement("input"); this.input.id = id; this.input.type = "text"; this.input.inputMode = "url"; this.input.autocomplete = "off"; this.input.spellcheck = false; this.input.placeholder = placeholder; this.input.maxLength = 512;
    this.#error.id = `${id}-error`; this.#error.className = "form-error"; this.#error.setAttribute("role", "status");
    this.#suggestions.id = `${id}-suggestions`; this.input.setAttribute("list", this.#suggestions.id); this.input.setAttribute("aria-describedby", `${id}-hint ${this.#error.id}`);
    const hint = document.createElement("p"); hint.id = `${id}-hint`; hint.className = "supporting"; hint.textContent = "Press Enter to add an address. Remove it with ×.";
    const add = document.createElement("button"); add.type = "button"; add.textContent = "Add"; add.setAttribute("aria-label", `Add ${label.toLowerCase()} address`); add.onclick = () => this.commit();
    const row = document.createElement("div"); row.className = "destination-entry"; row.append(this.input, add);
    host.append(fieldLabel, this.#chips, row, this.#suggestions, hint, this.#error);
    this.input.addEventListener("input", () => { this.#revision++; this.error(""); });
    this.input.addEventListener("keydown", event => { if (event.key === "Enter") { event.preventDefault(); this.commit(); } });
  }
  get revision() { return this.#revision; }
  get values() { return [...this.#values]; }
  reset(values: string[] = []) { this.#revision++; this.input.value = ""; this.#values = []; for (const value of values) { try { const normalized = this.normalize(value); if (!this.#values.includes(normalized) && this.#values.length < this.maximum) this.#values.push(normalized); } catch { /* Ignore malformed discovered values. */ } } this.error(""); this.render(); }
  suggest(values: string[]) { this.#suggestions.replaceChildren(...[...new Set(values)].filter(value => { try { return this.normalize(value) === value; } catch { return false; } }).map(value => { const option = document.createElement("option"); option.value = value; return option; })); }
  commit(): boolean {
    if (!this.input.value.trim()) return true;
    try { const value = this.normalize(this.input.value); if (this.#values.includes(value)) throw new Error("That address is already added."); if (this.#values.length >= this.maximum) throw new Error(`Choose up to ${this.maximum} addresses.`); this.#values.push(value); this.input.value = ""; this.#revision++; this.error(""); this.render(); return true; }
    catch (error) { this.error(error instanceof Error ? error.message : "Enter a valid address."); this.input.focus(); return false; }
  }
  private error(message: string) { this.#error.textContent = message; this.input.setAttribute("aria-invalid", String(!!message)); }
  private render() { this.#chips.replaceChildren(...this.#values.map(value => { const chip = document.createElement("span"); chip.className = "destination-chip"; const text = document.createElement("span"); text.textContent = value; const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "×"; remove.setAttribute("aria-label", `Remove ${value}`); remove.onclick = () => { this.#values = this.#values.filter(item => item !== value); this.#revision++; this.render(); this.input.focus(); }; chip.append(text, remove); return chip; })); }
}
