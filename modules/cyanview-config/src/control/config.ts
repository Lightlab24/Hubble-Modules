/** Module-owned MQTT endpoint; workspace labels never form protocol addresses. */
export interface CyanViewRcpConnectionDefinition {
  connectionId: string;
  name: string;
  host: string;
  /** Tried only while `host` won't connect: the address the controller was added by, when it isn't the base. */
  fallbackHost?: string | undefined;
  port: number;
  requestTimeoutMs: number;
  serial?: string;
}

export const commands = [
  ['select-camera', 'Select camera'],
  ['record-camera', 'Record camera (Toggle)'],
  ['toggle-camera-enabled', 'Enable / Disable Camera'],
  ['enable-all-cameras', 'Enable / Disable All Cameras'],
  ['single-switch', 'Single switch'],
  ['roll-enabled-cameras', 'Start Recording'],
  ['stop-enabled-cameras', 'Stop Recording'],
  ['roll-toggle-enabled-cameras', 'Toggle Recording'],
  ['nd-up-enabled-cameras', 'ND Up'],
  ['nd-down-enabled-cameras', 'ND Down'],
  ['iso-up-enabled-cameras', 'ISO Up'],
  ['iso-down-enabled-cameras', 'ISO Down'],
  ['base-gain-up-enabled-cameras', 'Base Gain Up'],
  ['base-gain-down-enabled-cameras', 'Base Gain Down'],
  ['save-white-balance-preset-enabled-cameras', 'Add preset (Sony VENICE)'],
] as const;
export type Command = typeof commands[number][0];
export const commandGroup = (command: Command) => command === 'select-camera' ? 'RCP set active camera' : 'Cyanview';
export const cameraCommands: readonly string[] = ['select-camera', 'record-camera', 'toggle-camera-enabled'];
export const localCommands: readonly string[] = ['toggle-camera-enabled', 'enable-all-cameras', 'single-switch'];
export const feedbackCommands = [...localCommands, 'select-camera', 'record-camera', 'roll-enabled-cameras', 'stop-enabled-cameras', 'roll-toggle-enabled-cameras'];
export const forActions = (...actions: string[]) => [{ field: 'actionType', values: actions }];
/** A tap starts these and only a hold this long stops them, so a stray tap can't cut a take. */
export const holdToStop = { ms: 2000 as const, when: forActions('record-camera') };
const cameraActions = ['select-camera', 'record-camera', 'toggle-camera-enabled'];
const groupRecordingActions = ['roll-enabled-cameras', 'stop-enabled-cameras', 'roll-toggle-enabled-cameras'];
/**
 * Feedback states, highest priority first. Each belongs to the actions where it means something, so a
 * row only lists and lights its own. Operators change their looks row by row in Hubble.
 */
export const feedbackTriggers = [
  { id: 'selected', label: 'Selected', part: 'background', color: '#37A65B', when: forActions('select-camera') },
  // From the moment a hold sends Stop until the camera reports it has stopped. Above Recording, which stays on until then.
  { id: 'stopping', label: 'Stopping', part: 'background', color: '#37A65B', effect: { kind: 'blink', cycleMs: 400 }, when: forActions('record-camera') },
  { id: 'rolling', label: 'Recording', part: 'background', color: '#E3242B', when: forActions('record-camera') },
  { id: 'enabled', label: 'Enabled', part: 'background', color: '#37A65B', when: forActions('toggle-camera-enabled') },
  { id: 'recording', label: 'Recording', part: 'bar', color: '#E3242B', effect: { kind: 'blink', cycleMs: 800 }, when: forActions('select-camera', 'toggle-camera-enabled') },
  { id: 'online', label: 'Online', part: 'outline', color: '#2563EB', when: forActions(...cameraActions) },
  { id: 'offline', label: 'Offline', part: 'outline', color: '#8A8F98', effect: { kind: 'fade', cycleMs: 2000 }, when: forActions(...cameraActions) },
  { id: 'all-enabled', label: 'All enabled', part: 'background', color: '#37A65B', when: forActions('enable-all-cameras') },
  { id: 'some-enabled', label: 'Some enabled', part: 'background', color: '#F59E0B', when: forActions('enable-all-cameras') },
  { id: 'single-switch', label: 'Single switch on', part: 'background', color: '#37A65B', when: forActions('single-switch') },
  { id: 'all-rolling', label: 'All rolling', part: 'background', color: '#E3242B', when: forActions(...groupRecordingActions) },
  { id: 'some-rolling', label: 'Some rolling', part: 'bar', color: '#F59E0B', when: forActions(...groupRecordingActions) },
] as const;
