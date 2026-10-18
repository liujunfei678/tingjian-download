export function isTrustedUI(sender, extensionBase) {
  try {
    const actual = new URL(sender.url);
    const expected = new URL(extensionBase);
    return actual.protocol === expected.protocol && actual.host === expected.host &&
      ['/panel/panel.html','/popup/popup.html'].includes(actual.pathname);
  } catch {return false;}
}
