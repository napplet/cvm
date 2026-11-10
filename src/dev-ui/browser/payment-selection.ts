import type { PaymentMethod } from "../../payments/contracts";

/** Method names and input requirements come from the authenticated service descriptor. */
export async function selectPaymentMethod(methods: readonly PaymentMethod[]): Promise<Readonly<{ method: PaymentMethod; token?: string; maxFee?: string }>> {
  if (!methods.length) throw new Error("PAYMENT_METHOD_UNAVAILABLE");
  if (methods.length === 1 && methods[0]!.input !== "direct") return { method: methods[0]! };
  const dialog = document.createElement("dialog");
  dialog.setAttribute("aria-label", "Choose how to add credits");
  const title = document.createElement("h2"); title.textContent = "Add credits";
  const label = document.createElement("label"); label.textContent = "Payment method ";
  const select = document.createElement("select");
  for (const method of methods) { const option = document.createElement("option"); option.value = method.id; option.textContent = method.label; select.append(option); }
  label.append(select);
  const details = document.createElement("p");
  const tokenLabel = document.createElement("label"); tokenLabel.textContent = "Payment token ";
  const token = document.createElement("textarea"); token.maxLength = 128_000; token.autocomplete = "off"; tokenLabel.append(token);
  const feeLabel = document.createElement("label"); feeLabel.textContent = "Maximum payment fee ";
  const fee = document.createElement("input"); fee.inputMode = "numeric"; fee.value = "0"; feeLabel.append(fee);
  const continueButton = document.createElement("button"); continueButton.textContent = "Continue";
  const cancel = document.createElement("button"); cancel.textContent = "Cancel";
  const update = () => { const method = methods.find(item => item.id === select.value)!; details.textContent = method.description ?? ""; tokenLabel.hidden = feeLabel.hidden = method.input !== "direct"; };
  select.onchange = update; update();
  dialog.append(title, label, details, tokenLabel, feeLabel, continueButton, cancel); document.body.append(dialog);
  try {
    return await new Promise((resolve, reject) => {
      dialog.oncancel = event => { event.preventDefault(); reject(new Error("PAYMENT_SELECTION_CANCELLED")); };
      cancel.onclick = () => reject(new Error("PAYMENT_SELECTION_CANCELLED"));
      continueButton.onclick = () => {
        const method = methods.find(item => item.id === select.value)!;
        if (method.input === "direct" && (!token.value || !/^(0|[1-9][0-9]*)$/u.test(fee.value))) { token.focus(); return; }
        resolve({ method, ...(method.input === "direct" ? { token: token.value, maxFee: fee.value } : {}) });
      };
      dialog.showModal();
    });
  } finally { token.value = ""; dialog.close(); dialog.remove(); }
}
