const TEXT_NODE = 3;

const strippedTemplates = new WeakSet<Element>();

export function cloneTemplate(document: Document, id: string): HTMLElement {
  const template = document.getElementById(id);

  if (template === null || !isTemplate(template)) {
    throw new Error(`Missing <template id="${id}">`);
  }

  if (!strippedTemplates.has(template)) {
    stripIndentation(template.content);
    strippedTemplates.add(template);
  }

  const root = template.content.firstElementChild;

  if (root === null) throw new Error(`Empty <template id="${id}">`);

  // SAFETY: templates live in the HTML shell, so their root elements are HTML elements.
  return document.importNode(root, true) as HTMLElement;
}

export function slot(root: Element, name: string): HTMLElement {
  const element = root.querySelector<HTMLElement>(`[data-slot="${name}"]`);

  if (element === null) throw new Error(`Missing data-slot="${name}" in <${root.localName}>`);

  return element;
}

function isTemplate(element: HTMLElement): element is HTMLTemplateElement {
  return element.localName === "template";
}

// The formatter indents template markup; indentation always holds a line break,
// while meaningful separators such as " " and " · " do not.
function stripIndentation(node: Node): void {
  for (const child of Array.from(node.childNodes)) {
    const text = child.textContent ?? "";

    if (child.nodeType === TEXT_NODE && text.trim() === "" && text.includes("\n")) {
      child.remove();
    } else {
      stripIndentation(child);
    }
  }
}
