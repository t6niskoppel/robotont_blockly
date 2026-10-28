// Which sensor previews are shown. Hidden ones drop their streams, which saves robot CPU and Wi-Fi.
// Remembered per browser and shared by the dashboard and the Blockly page.
export const previews = { rgb: true, depth: true, scan: true };
try {
  Object.assign(previews, JSON.parse(localStorage.getItem('previews')));
} catch {}
export function savePreviews() {
  try {
    localStorage.setItem('previews', JSON.stringify(previews));
  } catch {}
}
