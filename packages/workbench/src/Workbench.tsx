export function Workbench() {
  // 36 px pairs with trafficLightPosition in tauri.conf.json: change both or neither.
  return <header data-tauri-drag-region style={{ height: 36 }} />;
}
