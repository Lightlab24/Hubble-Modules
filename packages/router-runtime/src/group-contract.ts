import type { ButtonRotationStep } from '@hubble/module-contracts/interaction'
export interface RossRouteGroupActionScope {
  readonly workspaceId: string
  readonly moduleConnectionId: string
  readonly connectionId: string
  readonly groupId: string | null
}

export interface RossRouteGroupSelectSourceInput extends RossRouteGroupActionScope {
  readonly source: number
  readonly levels?: readonly number[]
}

export interface RossRouteGroupSelectDestinationInput extends RossRouteGroupActionScope {
  readonly destination: number
}

export interface RossRouteGroupCycleDestinationInput extends RossRouteGroupActionScope {
  readonly destinations: readonly number[]
  readonly step: ButtonRotationStep
  readonly wrap: boolean
}

export interface RossRouteGroupTakeInput extends RossRouteGroupActionScope {
  readonly levels?: readonly number[]
}

export interface RossRouteGroupToggleEnabledInput extends Omit<
  RossRouteGroupActionScope,
  'groupId'
> {
  readonly groupId: string
}

export interface RossRouteGroupRuntimeContract {
  selectSource(input: RossRouteGroupSelectSourceInput): Promise<void>
  selectDestination(input: RossRouteGroupSelectDestinationInput): Promise<void>
  cycleDestination(input: RossRouteGroupCycleDestinationInput): Promise<void>
  take(input: RossRouteGroupTakeInput): Promise<void>
  toggleGroupEnabled(input: RossRouteGroupToggleEnabledInput): Promise<void>
}
