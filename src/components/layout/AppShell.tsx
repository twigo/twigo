import { ActivityBar } from "./ActivityBar";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { TabBar } from "./TabBar";
import { MessageStream } from "./MessageStream";
import { DetailPanel } from "./DetailPanel";
import { SettingsPage } from "@/components/settings/SettingsPage";
import { useUi } from "@/store/ui";

export function AppShell() {
  const { sidebarOpen, detailOpen, activeView, settingsOpen } = useUi();
  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <ActivityBar />
        {sidebarOpen && !settingsOpen && <Sidebar />}

        <main className="flex min-w-0 flex-1 flex-col bg-background">
          {settingsOpen ? (
            <SettingsPage />
          ) : (
            <>
              <TabBar />
              <div className="flex min-h-0 flex-1">
                {activeView === "subjects" ? <MessageStream /> : <Placeholder />}
                {detailOpen && activeView === "subjects" && <DetailPanel />}
              </div>
            </>
          )}
        </main>
      </div>
      <StatusBar />
    </div>
  );
}

function Placeholder() {
  return (
    <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
      This section is under construction.
    </div>
  );
}
