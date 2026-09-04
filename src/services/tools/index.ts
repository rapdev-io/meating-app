import APP_CONFIG from "../../config/appIdentity.json";
import { ToolRegistry } from "./ToolRegistry";
import { createSearchNotesTool } from "./searchNotesTool";
import { getNoteTool } from "./getNoteTool";
import { createNoteTool } from "./createNoteTool";
import { updateNoteTool } from "./updateNoteTool";
import { listFoldersTool } from "./listFoldersTool";
import { clipboardTool } from "./clipboardTool";
import { webSearchTool } from "./webSearchTool";
import { calendarTool } from "./calendarTool";
import { calendarAvailabilityTool } from "./calendarAvailabilityTool";
import type { ContainerScope } from "../../types/chat";

export { ToolRegistry } from "./ToolRegistry";
export type { ToolDefinition, ToolResult } from "./ToolRegistry";

interface ToolRegistrySettings {
  isSignedIn: boolean;
  calendarConnected: boolean;
  cloudBackupEnabled: boolean;
  /** Pins search_notes to a container (overview chat); the LLM cannot widen it. */
  searchScope?: ContainerScope;
  webSearchEnabled: boolean;
}

export function createToolRegistry(settings: ToolRegistrySettings): ToolRegistry {
  const registry = new ToolRegistry();

  const useCloudSearch = settings.isSignedIn && settings.cloudBackupEnabled;
  registry.register(createSearchNotesTool({ useCloudSearch, fixedScope: settings.searchScope }));
  registry.register(getNoteTool);
  registry.register(createNoteTool);
  registry.register(updateNoteTool);
  registry.register(listFoldersTool);
  registry.register(clipboardTool);

  // webSearchEnabled reflects workspace policy only (default-allow when
  // unmanaged); agent-web-search itself proxies through OpenWhispr Cloud,
  // which Protein never initializes, so it needs its own gate here too.
  if (settings.isSignedIn && settings.webSearchEnabled && APP_CONFIG.enableOpenWhisprCloud) {
    registry.register(webSearchTool);
  }

  if (settings.calendarConnected) {
    registry.register(calendarTool);
    registry.register(calendarAvailabilityTool);
  }

  return registry;
}
