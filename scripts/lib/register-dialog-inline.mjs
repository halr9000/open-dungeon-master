// A module hook that answers @radix-ui/react-dialog with
// radix-dialog-inline.mjs, so a dialog component renders to a string. Under
// plain node the bare name arrives here; under Vitest the package is first
// resolved to its file and then imported natively, so the file's path is
// matched too. Activate with register("./lib/register-dialog-inline.mjs",
// import.meta.url) before importing the component.
const inline = new URL("./radix-dialog-inline.mjs", import.meta.url).href;

export function resolve(specifier, context, nextResolve) {
  if (specifier === "@radix-ui/react-dialog" || /[\\/]node_modules[\\/]@radix-ui[\\/]react-dialog[\\/]/.test(specifier)) {
    return { url: inline, shortCircuit: true };
  }
  return nextResolve(specifier, context);
}
