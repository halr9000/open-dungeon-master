// @radix-ui/react-dialog for a dialog rendered to a string by a test script
// (register-dialog-inline.mjs). Radix's portal renders nothing on the
// server, because it waits for a layout effect to find document.body, so a
// dialog rendered with renderToStaticMarkup came out empty. Here an open
// dialog renders its content in place, and a closed one (an InfoButton's
// inside it) renders none, as in the browser.
import { createContext, createElement, Fragment, useContext } from "react";

const Open = createContext(false);

export function Root({ open, defaultOpen = false, children }) {
  return createElement(Open.Provider, { value: open ?? defaultOpen }, children);
}

export function Portal({ children }) {
  return useContext(Open) ? createElement(Fragment, null, children) : null;
}

export function Overlay() {
  return null;
}

export function Content({ children, className }) {
  return createElement("div", { className }, children);
}

export function Title({ children, className }) {
  return createElement("h2", { className }, children);
}

export function Description({ children, className }) {
  return createElement("p", { className }, children);
}

export function Close({ children, className }) {
  return createElement("button", { type: "button", className }, children);
}

export function Trigger({ children, className }) {
  return createElement("button", { type: "button", className }, children);
}
