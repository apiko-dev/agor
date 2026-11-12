import type {
  AgenticToolName,
  PersistedScheduleAgenticToolConfig,
  ScheduleAgenticToolConfig,
} from '@agor-live/client';
import {
  USER_DEFAULT_AGENTIC_CONFIGURATION,
  WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION,
} from '@agor-live/client';
import {
  type AgenticFormValues,
  buildScheduleConfigFromFormValues,
} from '../AgenticToolConfigForm';
import { INLINE_AGENTIC_CONFIGURATION } from '../AgenticToolConfigurationPicker';

export interface AutomationAgenticFormValues extends AgenticFormValues {
  /** The picker's selection: a reserved default, a preset id, or inline. */
  agenticToolPresetId?: string;
}

/**
 * The agentic config an unattended run (schedule or teammate webhook) persists
 * for the picker's selection. Reserved defaults and presets resolve at each run.
 */
export function buildAutomationAgenticToolConfig(
  tool: AgenticToolName,
  values: AutomationAgenticFormValues,
  previous?: PersistedScheduleAgenticToolConfig
): ScheduleAgenticToolConfig {
  const selection = values.agenticToolPresetId;
  if (
    selection === USER_DEFAULT_AGENTIC_CONFIGURATION ||
    selection === WORKSPACE_DEFAULT_AGENTIC_CONFIGURATION
  ) {
    return { agentic_tool: tool, configuration_reference: selection };
  }
  if (selection && selection !== INLINE_AGENTIC_CONFIGURATION) {
    return {
      agentic_tool: tool,
      preset_id: selection as NonNullable<ScheduleAgenticToolConfig['preset_id']>,
    };
  }
  return buildScheduleConfigFromFormValues(
    tool,
    {
      modelConfig: values.modelConfig,
      effort: values.effort,
      permissionMode: values.permissionMode,
      codexSandboxMode: values.codexSandboxMode,
      codexApprovalPolicy: values.codexApprovalPolicy,
      codexNetworkAccess: values.codexNetworkAccess,
      codexIncludePlugins: values.codexIncludePlugins,
    },
    previous
  );
}
