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
export const feedbackCommands = [...localCommands, 'select-camera', 'roll-enabled-cameras', 'stop-enabled-cameras', 'roll-toggle-enabled-cameras'];
