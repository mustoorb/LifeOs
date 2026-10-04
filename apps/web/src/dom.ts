// DOM helpers: text only, never innerHTML.

export type Child = Node | string | number | null | undefined | false;

export interface Props {
  class?: string;
  id?: string;
  attrs?: Record<string, string>;
  style?: Record<string, string>;
  on?: Partial<Record<keyof HTMLElementEventMap, (event: Event) => void>>;
}

function append(el: Element, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'number' ? String(child) : child);
  }
}

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, props: Props = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  if (props.id) el.id = props.id;
  for (const [key, value] of Object.entries(props.attrs ?? {})) el.setAttribute(key, value);
  for (const [key, value] of Object.entries(props.style ?? {})) el.style.setProperty(key, value);
  for (const [event, handler] of Object.entries(props.on ?? {})) el.addEventListener(event, handler as EventListener);
  append(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';

/** An SVG element. Attribute values are set as attributes, so they are never parsed as markup. */
export function svg<K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, ...children: Child[]): SVGElementTagNameMap[K] {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) el.setAttribute(key, String(value));
  append(el, children);
  return el;
}

export const prefersReducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** localStorage that never throws: private windows and blocked storage just forget. */
export const store = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      // Not remembering is fine.
    }
  },
};
