// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import "./crt-prompt.js"; // side-effect: registers <crt-prompt> in the custom-element registry
import type { CrtPrompt } from "./crt-prompt.js";

describe("<crt-prompt>", () => {
  let el: CrtPrompt;

  beforeEach(() => {
    el = document.createElement("crt-prompt");
    document.body.appendChild(el);
  });

  afterEach(() => {
    el.remove();
  });

  function getForm(): HTMLFormElement {
    return el.shadowRoot!.querySelector<HTMLFormElement>("#prompt-form")!;
  }

  function getInput(): HTMLInputElement {
    return el.shadowRoot!.querySelector<HTMLInputElement>("#cmd")!;
  }

  it("dispatches command event with trimmed value and clears input on non-empty submit", async () => {
    await el.updateComplete;
    const input = getInput();
    input.value = "  go north  ";

    let received: CustomEvent | null = null;
    el.addEventListener("command", (ev) => {
      received = ev as CustomEvent;
    });

    getForm().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    expect(received).not.toBeNull();
    expect((received as unknown as CustomEvent).detail.line).toBe("go north");
    expect(input.value).toBe("");
    // must bubble + compose (cross shadow boundary)
    expect((received as unknown as CustomEvent).bubbles).toBe(true);
    expect((received as unknown as CustomEvent).composed).toBe(true);
  });

  it("dispatches no command event when value is empty or whitespace-only", async () => {
    await el.updateComplete;
    const input = getInput();

    let called = false;
    el.addEventListener("command", () => {
      called = true;
    });

    // whitespace only
    input.value = "   ";
    getForm().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(called).toBe(false);

    // empty string
    input.value = "";
    getForm().dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    expect(called).toBe(false);
  });

  it("recalls history with ArrowUp/Down after submitting 'a' then 'b'", async () => {
    await el.updateComplete;
    const input = getInput();
    const form = getForm();

    // Submit "a"
    input.value = "a";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    // Submit "b"
    input.value = "b";
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));

    // historyIdx is now 2 (past the end), history = ["a", "b"]
    // ArrowUp → idx=1, value="b"
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(input.value).toBe("b");

    // ArrowUp → idx=0, value="a"
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(input.value).toBe("a");

    // ArrowDown → idx=1, value="b"
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(input.value).toBe("b");

    // ArrowDown → idx=2 (past end), value=""
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    expect(input.value).toBe("");
  });

  it("disables the inner input when disabled property is set to true", async () => {
    await el.updateComplete;
    expect(getInput().disabled).toBe(false);

    el.disabled = true;
    await el.updateComplete;

    expect(getInput().disabled).toBe(true);

    el.disabled = false;
    await el.updateComplete;

    expect(getInput().disabled).toBe(false);
  });

  it("setValue/getValue/clear operate on the input value", async () => {
    await el.updateComplete;

    el.setValue("go north");
    expect(el.getValue()).toBe("go north");

    el.clear();
    expect(el.getValue()).toBe("");
  });
});
