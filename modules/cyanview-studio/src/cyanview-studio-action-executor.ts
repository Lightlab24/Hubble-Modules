import type {
  CyanViewStudioSelectFeedActionDefinition,
  CyanViewStudioSelectFeedIdActionDefinition,
  CyanViewStudioSelectFeedNumberActionDefinition,
} from './config.js'

import {
  ActionAbortedError,
  type ActionExecutionContext,
  type AdapterActionResult,
  type TypedActionExecutor,
} from '@hubble/module-contracts/execution'
import {
  CyanViewStudioConnectionError,
  type CyanViewStudioConnectionManagerContract,
} from './cyanview-studio-connection-manager.js'

type CyanViewStudioActionDefinition =
  | CyanViewStudioSelectFeedActionDefinition
  | CyanViewStudioSelectFeedNumberActionDefinition
  | CyanViewStudioSelectFeedIdActionDefinition

export class CyanViewStudioActionExecutor implements TypedActionExecutor<CyanViewStudioActionDefinition> {
  constructor(private readonly connections: CyanViewStudioConnectionManagerContract) {}

  async execute(
    action: CyanViewStudioActionDefinition,
    context: ActionExecutionContext,
  ): Promise<AdapterActionResult> {
    if (context.signal.aborted) throw new ActionAbortedError()
    try {
      if (action.type === 'cyanview-studio.select-feed') {
        await this.connections.selectFeed(action.connectionId, action.cameraId)
      } else if (action.type === 'cyanview-studio.select-feed-number') {
        await this.connections.selectFeedByNumber(action.connectionId, action.feedNumber)
      } else {
        await this.connections.selectFeedByFeedId(action.connectionId, action.feedId)
      }
      return { outcome: 'success' }
    } catch (error: unknown) {
      return mapCyanViewError(error)
    }
  }
}

function mapCyanViewError(error: unknown): AdapterActionResult {
  if (!(error instanceof CyanViewStudioConnectionError)) {
    return failure(
      'cyanview_protocol_error',
      'CyanView Studio feed selection failed unexpectedly',
    )
  }
  switch (error.code) {
    case 'cyanview_unconfigured':
      return failure('cyanview_unconfigured', 'CyanView Studio connection is unavailable')
    case 'cyanview_unavailable':
      return failure('cyanview_unavailable', 'CyanView Studio is unavailable')
    case 'cyanview_timeout':
      return failure(
        'cyanview_timeout',
        'CyanView Studio did not respond before the request timeout',
      )
    case 'cyanview_camera_not_found':
      return failure(
        'cyanview_camera_not_found',
        'CyanView Studio could not find the requested camera',
      )
    case 'cyanview_feed_not_found':
      return failure(
        'cyanview_feed_not_found',
        'CyanView Studio could not find the requested feed',
      )
    case 'cyanview_feed_id_unsupported':
      return failure(
        'cyanview_invalid_request',
        'This saved action uses a database Feed ID; add Select Feed and enter the feed number shown in Studio',
      )
    case 'cyanview_feed_number_unsupported':
      return failure(
        'cyanview_invalid_request',
        'This Studio API does not support feed-number selection; update Studio to use Select Feed',
      )
    case 'cyanview_invalid_request':
      return failure(
        'cyanview_invalid_request',
        'CyanView Studio rejected the feed selection request',
      )
    case 'cyanview_protocol_error':
      return failure('cyanview_protocol_error', 'CyanView Studio returned an invalid response')
  }
}

function failure(
  errorCode: Extract<AdapterActionResult, { outcome: 'failure' }>['errorCode'],
  errorMessage: string,
): AdapterActionResult {
  return { outcome: 'failure', errorCode, errorMessage }
}
