import { describe, expect, test } from "bun:test";
import { createUiWindow } from "../../helpers/ui-document.ts";

const TEMPLATE_MODULE = "../../../ui/app/template.ts";

describe("cloneTemplate", () => {
  test("names the template id when the shell lacks it", async () => {
    // #given
    const document = createUiWindow().document;
    const { cloneTemplate } = await import(TEMPLATE_MODULE);

    // #when
    const clone = () => cloneTemplate(document, "tpl-unknown");

    // #then
    expect(clone).toThrow('Missing <template id="tpl-unknown">');
  });
});

describe("slot", () => {
  test("names the slot and its root when the template lacks it", async () => {
    // #given
    const document = createUiWindow().document;
    const { cloneTemplate, slot } = await import(TEMPLATE_MODULE);
    const root = cloneTemplate(document, "tpl-episode-item");

    // #when
    const find = () => slot(root, "unknown");

    // #then
    expect(find).toThrow('Missing data-slot="unknown" in <li>');
  });
});
