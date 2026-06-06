import { ActivityBar } from "./ActivityBar";
import { Sidebar } from "./Sidebar";
import { StatusBar } from "./StatusBar";
import { TabBar } from "./TabBar";
import { MessageStream } from "./MessageStream";
import { DetailPanel } from "./DetailPanel";
import { SettingsPage } from "@/components/settings/SettingsPage";
import {
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
} from "@/components/ui/resizable";
import { useUi } from "@/store/ui";

export function AppShell() {
  const { sidebarOpen, detailOpen, activeView, settingsOpen } = useUi();
  const showSidebar = sidebarOpen && !settingsOpen;
  const showDetail = detailOpen && activeView === "subjects" && !settingsOpen;

  return (
    <div className="flex h-full flex-col">
      <div className="flex min-h-0 flex-1">
        <ActivityBar />

        {settingsOpen ? (
          <SettingsPage />
        ) : (
          <ResizablePanelGroup
            orientation="horizontal"
            className="min-h-0 flex-1"
          >
            {showSidebar && (
              <>
                <ResizablePanel
                  id="sidebar"
                  defaultSize={20}
                  minSize={12}
                  maxSize={32}
                >
                  <Sidebar />
                </ResizablePanel>
                <ResizableHandle withHandle />
              </>
            )}

            <ResizablePanel id="main" minSize={30}>
              <main className="flex h-full min-w-0 flex-col bg-background">
                <TabBar />
                <div className="flex min-h-0 flex-1">
                  {activeView === "subjects" ? (
                    <MessageStream />
                  ) : (
                    <Placeholder />
                  )}
                </div>
              </main>
            </ResizablePanel>

            {showDetail && (
              <>
                <ResizableHandle withHandle />
                <ResizablePanel
                  id="detail"
                  defaultSize={24}
                  minSize={15}
                  maxSize={45}
                >
                  <DetailPanel />
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        )}
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
