import type { z } from 'zod'
export { isDirectionalButtonInteraction } from '@hubble/module-contracts/interaction'
export type RossUltrixOgpConnectionDefinition = {
  readonly connectionId: string & z.core.$brand<'ConnectionId'>
  readonly type: 'ross-ultrix-ogp'
  readonly name: string
  readonly enabled: boolean
  readonly host: string
  readonly port: number
  readonly sourceLimit: number
  readonly destinationLimit: number
  readonly levels: number
  readonly requestTimeoutMs: number
  readonly reconnectDelayMs: number
  readonly schemaVersion: 1
  readonly moduleBinding?:
    | {
        package: { moduleId: string; version: string; digest: string }
        configVersion: number
        pinned: boolean
        autoUpdate?: 'inherit' | 'on' | 'off' | undefined
        settings?: Record<string, z.core.util.JSONType> | undefined
      }
    | undefined
}
export type EvertzQuartzConnectionDefinition = {
  readonly connectionId: string & z.core.$brand<'ConnectionId'>
  readonly name: string
  readonly enabled: boolean
  readonly host: string
  readonly port: number
  readonly sourceLimit: number
  readonly destinationLimit: number
  readonly requestTimeoutMs: number
  readonly reconnectDelayMs: number
  readonly schemaVersion: 1
  readonly type: 'evertz-quartz'
  readonly levels: number
  readonly levelSystem: '8-level' | '16-level' | 'magnum'
  readonly refreshIntervalSeconds: number
  readonly moduleBinding?:
    | {
        package: { moduleId: string; version: string; digest: string }
        configVersion: number
        pinned: boolean
        autoUpdate?: 'inherit' | 'on' | 'off' | undefined
        settings?: Record<string, z.core.util.JSONType> | undefined
      }
    | undefined
}
export type AjaKumoConnectionDefinition = {
  readonly connectionId: string & z.core.$brand<'ConnectionId'>
  readonly name: string
  readonly enabled: boolean
  readonly host: string
  readonly port: number
  readonly requestTimeoutMs: number
  readonly reconnectDelayMs: number
  readonly schemaVersion: 1
  readonly type: 'aja-kumo'
  readonly password: string
  readonly moduleBinding?:
    | {
        package: { moduleId: string; version: string; digest: string }
        configVersion: number
        pinned: boolean
        autoUpdate?: 'inherit' | 'on' | 'off' | undefined
        settings?: Record<string, z.core.util.JSONType> | undefined
      }
    | undefined
  readonly sourceLimit?: number | undefined
  readonly destinationLimit?: number | undefined
}
export type BlackmagicVideohubConnectionDefinition = {
  readonly connectionId: string & z.core.$brand<'ConnectionId'>
  readonly type: 'blackmagic-videohub'
  readonly name: string
  readonly enabled: boolean
  readonly host: string
  readonly port: number
  readonly requestTimeoutMs: number
  readonly reconnectDelayMs: number
  readonly schemaVersion: 1
  readonly moduleBinding?:
    | {
        package: { moduleId: string; version: string; digest: string }
        configVersion: number
        pinned: boolean
        autoUpdate?: 'inherit' | 'on' | 'off' | undefined
        settings?: Record<string, z.core.util.JSONType> | undefined
      }
    | undefined
  readonly sourceLimit?: number | undefined
  readonly destinationLimit?: number | undefined
}
export type RossActionDefinition =
  | Readonly<{
      type: 'ross-swp08.select-source'
      groupId: (string & z.core.$brand<'RossActionGroupId'>) | null
      source: number
      levels: readonly number[]
      drivesTally: boolean
      feedbackColor: string & z.core.$brand<'RgbHex'>
      actionId: string
      actionColumnId: string & z.core.$brand<'ActionColumnId'>
      interaction:
        | 'press'
        | 'rotate-left'
        | 'rotate-right'
        | 'long-press-1s'
        | 'long-press-2s'
        | 'long-press-3s'
      connectionId: string & z.core.$brand<'ConnectionId'>
      moduleConnectionId: string & z.core.$brand<'WorkspaceModuleConnectionId'>
      enabled: boolean
      wrap?: boolean | undefined
    }>
  | Readonly<{
      type: 'ross-swp08.select-destination'
      groupId: (string & z.core.$brand<'RossActionGroupId'>) | null
      destination: number
      drivesTally: boolean
      feedbackColor: string & z.core.$brand<'RgbHex'>
      actionId: string
      actionColumnId: string & z.core.$brand<'ActionColumnId'>
      interaction:
        | 'press'
        | 'rotate-left'
        | 'rotate-right'
        | 'long-press-1s'
        | 'long-press-2s'
        | 'long-press-3s'
      connectionId: string & z.core.$brand<'ConnectionId'>
      moduleConnectionId: string & z.core.$brand<'WorkspaceModuleConnectionId'>
      enabled: boolean
      destinations?: readonly number[] | undefined
      feedbackColors?: readonly (string & z.core.$brand<'RgbHex'>)[] | undefined
      wrap?: boolean | undefined
    }>
  | Readonly<{
      type: 'ross-swp08.take'
      groupId: (string & z.core.$brand<'RossActionGroupId'>) | null
      levels: readonly number[]
      drivesTally: boolean
      feedbackColor: string & z.core.$brand<'RgbHex'>
      actionId: string
      actionColumnId: string & z.core.$brand<'ActionColumnId'>
      interaction:
        | 'press'
        | 'rotate-left'
        | 'rotate-right'
        | 'long-press-1s'
        | 'long-press-2s'
        | 'long-press-3s'
      connectionId: string & z.core.$brand<'ConnectionId'>
      moduleConnectionId: string & z.core.$brand<'WorkspaceModuleConnectionId'>
      enabled: boolean
      wrap?: boolean | undefined
    }>
  | Readonly<{
      type: 'ross-swp08.toggle-group-enabled'
      groupId: string & z.core.$brand<'RossActionGroupId'>
      drivesTally: boolean
      feedbackColor: string & z.core.$brand<'RgbHex'>
      feedbackInactiveColor: (string & z.core.$brand<'RgbHex'>) | null
      actionId: string
      actionColumnId: string & z.core.$brand<'ActionColumnId'>
      interaction:
        | 'press'
        | 'rotate-left'
        | 'rotate-right'
        | 'long-press-1s'
        | 'long-press-2s'
        | 'long-press-3s'
      connectionId: string & z.core.$brand<'ConnectionId'>
      moduleConnectionId: string & z.core.$brand<'WorkspaceModuleConnectionId'>
      enabled: boolean
      wrap?: boolean | undefined
    }>
  | Readonly<{
      type: 'ross-swp08.direct-route'
      source: number
      destination: number
      levels: readonly number[]
      drivesTally: boolean
      feedbackColor: string & z.core.$brand<'RgbHex'>
      actionId: string
      actionColumnId: string & z.core.$brand<'ActionColumnId'>
      interaction:
        | 'press'
        | 'rotate-left'
        | 'rotate-right'
        | 'long-press-1s'
        | 'long-press-2s'
        | 'long-press-3s'
      connectionId: string & z.core.$brand<'ConnectionId'>
      moduleConnectionId: string & z.core.$brand<'WorkspaceModuleConnectionId'>
      enabled: boolean
      wrap?: boolean | undefined
    }>
  | Readonly<{
      type: 'ross-swp08.refresh-names'
      actionId: string
      actionColumnId: string & z.core.$brand<'ActionColumnId'>
      interaction:
        | 'press'
        | 'rotate-left'
        | 'rotate-right'
        | 'long-press-1s'
        | 'long-press-2s'
        | 'long-press-3s'
      connectionId: string & z.core.$brand<'ConnectionId'>
      moduleConnectionId: string & z.core.$brand<'WorkspaceModuleConnectionId'>
      enabled: boolean
      wrap?: boolean | undefined
    }>
export type EvertzQuartzControlActionDefinition =
  | Readonly<{
      type: 'evertz-quartz.lock-destination'
      destination: number
      actionId: string
      actionColumnId: string & z.core.$brand<'ActionColumnId'>
      interaction:
        | 'press'
        | 'rotate-left'
        | 'rotate-right'
        | 'long-press-1s'
        | 'long-press-2s'
        | 'long-press-3s'
      connectionId: string & z.core.$brand<'ConnectionId'>
      moduleConnectionId: string & z.core.$brand<'WorkspaceModuleConnectionId'>
      enabled: boolean
      wrap?: boolean | undefined
    }>
  | Readonly<{
      type: 'evertz-quartz.unlock-destination'
      destination: number
      actionId: string
      actionColumnId: string & z.core.$brand<'ActionColumnId'>
      interaction:
        | 'press'
        | 'rotate-left'
        | 'rotate-right'
        | 'long-press-1s'
        | 'long-press-2s'
        | 'long-press-3s'
      connectionId: string & z.core.$brand<'ConnectionId'>
      moduleConnectionId: string & z.core.$brand<'WorkspaceModuleConnectionId'>
      enabled: boolean
      wrap?: boolean | undefined
    }>
  | Readonly<{
      type: 'evertz-quartz.recall-salvo'
      salvo: number
      actionId: string
      actionColumnId: string & z.core.$brand<'ActionColumnId'>
      interaction:
        | 'press'
        | 'rotate-left'
        | 'rotate-right'
        | 'long-press-1s'
        | 'long-press-2s'
        | 'long-press-3s'
      connectionId: string & z.core.$brand<'ConnectionId'>
      moduleConnectionId: string & z.core.$brand<'WorkspaceModuleConnectionId'>
      enabled: boolean
      wrap?: boolean | undefined
    }>
export type AjaKumoActionDefinition =
  | Readonly<{
      type: 'aja-kumo.select-source'
      groupId: (string & z.core.$brand<'RossActionGroupId'>) | null
      source: number
      drivesTally: boolean
      feedbackColor: string & z.core.$brand<'RgbHex'>
      actionId: string
      actionColumnId: string & z.core.$brand<'ActionColumnId'>
      interaction:
        | 'press'
        | 'rotate-left'
        | 'rotate-right'
        | 'long-press-1s'
        | 'long-press-2s'
        | 'long-press-3s'
      connectionId: string & z.core.$brand<'ConnectionId'>
      moduleConnectionId: string & z.core.$brand<'WorkspaceModuleConnectionId'>
      enabled: boolean
      wrap?: boolean | undefined
    }>
  | Readonly<{
      type: 'aja-kumo.select-destination'
      groupId: (string & z.core.$brand<'RossActionGroupId'>) | null
      destination: number
      drivesTally: boolean
      feedbackColor: string & z.core.$brand<'RgbHex'>
      actionId: string
      actionColumnId: string & z.core.$brand<'ActionColumnId'>
      interaction:
        | 'press'
        | 'rotate-left'
        | 'rotate-right'
        | 'long-press-1s'
        | 'long-press-2s'
        | 'long-press-3s'
      connectionId: string & z.core.$brand<'ConnectionId'>
      moduleConnectionId: string & z.core.$brand<'WorkspaceModuleConnectionId'>
      enabled: boolean
      destinations?: readonly number[] | undefined
      feedbackColors?: readonly (string & z.core.$brand<'RgbHex'>)[] | undefined
      wrap?: boolean | undefined
    }>
  | Readonly<{
      type: 'aja-kumo.take'
      groupId: (string & z.core.$brand<'RossActionGroupId'>) | null
      drivesTally: boolean
      feedbackColor: string & z.core.$brand<'RgbHex'>
      actionId: string
      actionColumnId: string & z.core.$brand<'ActionColumnId'>
      interaction:
        | 'press'
        | 'rotate-left'
        | 'rotate-right'
        | 'long-press-1s'
        | 'long-press-2s'
        | 'long-press-3s'
      connectionId: string & z.core.$brand<'ConnectionId'>
      moduleConnectionId: string & z.core.$brand<'WorkspaceModuleConnectionId'>
      enabled: boolean
      wrap?: boolean | undefined
    }>
  | Readonly<{
      type: 'aja-kumo.toggle-group-enabled'
      groupId: string & z.core.$brand<'RossActionGroupId'>
      drivesTally: boolean
      feedbackColor: string & z.core.$brand<'RgbHex'>
      feedbackInactiveColor: (string & z.core.$brand<'RgbHex'>) | null
      actionId: string
      actionColumnId: string & z.core.$brand<'ActionColumnId'>
      interaction:
        | 'press'
        | 'rotate-left'
        | 'rotate-right'
        | 'long-press-1s'
        | 'long-press-2s'
        | 'long-press-3s'
      connectionId: string & z.core.$brand<'ConnectionId'>
      moduleConnectionId: string & z.core.$brand<'WorkspaceModuleConnectionId'>
      enabled: boolean
      wrap?: boolean | undefined
    }>
  | Readonly<{
      type: 'aja-kumo.direct-route'
      source: number
      destination: number
      drivesTally: boolean
      feedbackColor: string & z.core.$brand<'RgbHex'>
      actionId: string
      actionColumnId: string & z.core.$brand<'ActionColumnId'>
      interaction:
        | 'press'
        | 'rotate-left'
        | 'rotate-right'
        | 'long-press-1s'
        | 'long-press-2s'
        | 'long-press-3s'
      connectionId: string & z.core.$brand<'ConnectionId'>
      moduleConnectionId: string & z.core.$brand<'WorkspaceModuleConnectionId'>
      enabled: boolean
      wrap?: boolean | undefined
    }>
  | Readonly<{
      type: 'aja-kumo.refresh-names'
      actionId: string
      actionColumnId: string & z.core.$brand<'ActionColumnId'>
      interaction:
        | 'press'
        | 'rotate-left'
        | 'rotate-right'
        | 'long-press-1s'
        | 'long-press-2s'
        | 'long-press-3s'
      connectionId: string & z.core.$brand<'ConnectionId'>
      moduleConnectionId: string & z.core.$brand<'WorkspaceModuleConnectionId'>
      enabled: boolean
      wrap?: boolean | undefined
    }>
  | Readonly<{
      type: 'aja-kumo.recall-salvo'
      salvo: number
      actionId: string
      actionColumnId: string & z.core.$brand<'ActionColumnId'>
      interaction:
        | 'press'
        | 'rotate-left'
        | 'rotate-right'
        | 'long-press-1s'
        | 'long-press-2s'
        | 'long-press-3s'
      connectionId: string & z.core.$brand<'ConnectionId'>
      moduleConnectionId: string & z.core.$brand<'WorkspaceModuleConnectionId'>
      enabled: boolean
      wrap?: boolean | undefined
    }>
export type BlackmagicVideohubActionDefinition =
  | Readonly<{
      type: 'blackmagic-videohub.select-source'
      groupId: (string & z.core.$brand<'RossActionGroupId'>) | null
      source: number
      drivesTally: boolean
      feedbackColor: string & z.core.$brand<'RgbHex'>
      actionId: string
      actionColumnId: string & z.core.$brand<'ActionColumnId'>
      interaction:
        | 'press'
        | 'rotate-left'
        | 'rotate-right'
        | 'long-press-1s'
        | 'long-press-2s'
        | 'long-press-3s'
      connectionId: string & z.core.$brand<'ConnectionId'>
      moduleConnectionId: string & z.core.$brand<'WorkspaceModuleConnectionId'>
      enabled: boolean
      wrap?: boolean | undefined
    }>
  | Readonly<{
      type: 'blackmagic-videohub.select-destination'
      groupId: (string & z.core.$brand<'RossActionGroupId'>) | null
      destination: number
      drivesTally: boolean
      feedbackColor: string & z.core.$brand<'RgbHex'>
      actionId: string
      actionColumnId: string & z.core.$brand<'ActionColumnId'>
      interaction:
        | 'press'
        | 'rotate-left'
        | 'rotate-right'
        | 'long-press-1s'
        | 'long-press-2s'
        | 'long-press-3s'
      connectionId: string & z.core.$brand<'ConnectionId'>
      moduleConnectionId: string & z.core.$brand<'WorkspaceModuleConnectionId'>
      enabled: boolean
      destinations?: readonly number[] | undefined
      feedbackColors?: readonly (string & z.core.$brand<'RgbHex'>)[] | undefined
      wrap?: boolean | undefined
    }>
  | Readonly<{
      type: 'blackmagic-videohub.take'
      groupId: (string & z.core.$brand<'RossActionGroupId'>) | null
      drivesTally: boolean
      feedbackColor: string & z.core.$brand<'RgbHex'>
      actionId: string
      actionColumnId: string & z.core.$brand<'ActionColumnId'>
      interaction:
        | 'press'
        | 'rotate-left'
        | 'rotate-right'
        | 'long-press-1s'
        | 'long-press-2s'
        | 'long-press-3s'
      connectionId: string & z.core.$brand<'ConnectionId'>
      moduleConnectionId: string & z.core.$brand<'WorkspaceModuleConnectionId'>
      enabled: boolean
      wrap?: boolean | undefined
    }>
  | Readonly<{
      type: 'blackmagic-videohub.toggle-group-enabled'
      groupId: string & z.core.$brand<'RossActionGroupId'>
      drivesTally: boolean
      feedbackColor: string & z.core.$brand<'RgbHex'>
      feedbackInactiveColor: (string & z.core.$brand<'RgbHex'>) | null
      actionId: string
      actionColumnId: string & z.core.$brand<'ActionColumnId'>
      interaction:
        | 'press'
        | 'rotate-left'
        | 'rotate-right'
        | 'long-press-1s'
        | 'long-press-2s'
        | 'long-press-3s'
      connectionId: string & z.core.$brand<'ConnectionId'>
      moduleConnectionId: string & z.core.$brand<'WorkspaceModuleConnectionId'>
      enabled: boolean
      wrap?: boolean | undefined
    }>
  | Readonly<{
      type: 'blackmagic-videohub.direct-route'
      source: number
      destination: number
      drivesTally: boolean
      feedbackColor: string & z.core.$brand<'RgbHex'>
      actionId: string
      actionColumnId: string & z.core.$brand<'ActionColumnId'>
      interaction:
        | 'press'
        | 'rotate-left'
        | 'rotate-right'
        | 'long-press-1s'
        | 'long-press-2s'
        | 'long-press-3s'
      connectionId: string & z.core.$brand<'ConnectionId'>
      moduleConnectionId: string & z.core.$brand<'WorkspaceModuleConnectionId'>
      enabled: boolean
      wrap?: boolean | undefined
    }>
  | Readonly<{
      type: 'blackmagic-videohub.refresh-names'
      actionId: string
      actionColumnId: string & z.core.$brand<'ActionColumnId'>
      interaction:
        | 'press'
        | 'rotate-left'
        | 'rotate-right'
        | 'long-press-1s'
        | 'long-press-2s'
        | 'long-press-3s'
      connectionId: string & z.core.$brand<'ConnectionId'>
      moduleConnectionId: string & z.core.$brand<'WorkspaceModuleConnectionId'>
      enabled: boolean
      wrap?: boolean | undefined
    }>
export type RouterConnectionDefinition =
  | RossUltrixOgpConnectionDefinition
  | EvertzQuartzConnectionDefinition
  | AjaKumoConnectionDefinition
  | BlackmagicVideohubConnectionDefinition
export type ConnectionDefinition = RouterConnectionDefinition
