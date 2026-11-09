import { ModuleMatrixSchema } from '@hubble/module-sdk';
import { commands, cameraCommands, feedbackCommands, localCommands } from './config.js';

export const matrix = ModuleMatrixSchema.parse({
  id: 'camera-control', label: 'Cyanview', actionId: 'camera-control', feedbackId: 'camera-control', primaryField: 'actionType',
  // A row with no action is meant to be empty, so nothing on it is missing.
  inactiveWhen: [{ field: 'actionType', values: [''] }],
  fields: [
    { id: 'enabled', label: 'Enabled', type: 'boolean', default: true, fill: 'copy', width: 88 },
    { id: 'actionType', label: 'Action', type: 'choice', default: '', required: false, fill: 'copy', width: 255,
      choices: commands.map(([value, label]) => ({ value, label })), choiceProvider: 'control-actions' },
    // The shared Matrix stores dynamic references as text and presents the provider's labels.
    { id: 'module.controllerId', label: 'Cyanview controller', type: 'text', default: '', required: true, fill: 'copy', width: 240,
      choiceProvider: 'control-controllers', emptyMessage: 'Add a controller on Cyanview’s Devices page.',
      enabledWhen: [{ field: 'actionType', values: commands.map(([value]) => value) }],
      // These only change the saved ticks, so nothing needs a controller. Left blank, they cover every controller.
      rules: [{ when: [{ field: 'actionType', values: [...localCommands] }], set: { required: false } }] },
    { id: 'module.cameraNumber', label: 'Camera', type: 'number', default: null, required: true, integer: true, min: 1, max: 999999,
      formula: true, fill: 'series', width: 240, choiceProvider: 'control-cameras', choiceFields: ['module.cameraNumber'],
      enabledWhen: [{ field: 'actionType', values: [...cameraCommands] }] },
    { id: 'module.feedbackEnabled', label: 'Button Feedback', type: 'boolean', default: true, fill: 'copy', width: 130,
      enabledWhen: [{ field: 'actionType', values: feedbackCommands }] },
    { id: 'module.feedbackColor', label: 'Feedback Color', type: 'color', colorMode: 'pair', default: '#3A3A40 | #37A65B', fill: 'copy', width: 155,
      enabledWhen: [{ field: 'actionType', values: feedbackCommands }, { field: 'module.feedbackEnabled', values: [true] }] },
  ],
});

const controller = { id: 'controllerId', label: 'Cyanview controller', type: 'choice' as const, default: '', required: true, choices: [], choiceProvider: 'control-controllers' };
export const controlActions = commands.map(([id, label]) => ({
  id, label, description: 'Control cameras on one named Cyanview controller.',
  completion: 'response' as const, completionAlternatives: ['local' as const, 'state-confirmed' as const], timeoutMs: 120000,
  fields: [{ ...controller, required: !localCommands.includes(id), choiceProvider: id === 'select-camera' ? 'control-rcps' : 'control-controllers' }, ...(cameraCommands.includes(id) ? [{ id: 'cameraNumber', label: 'Camera number', type: 'number' as const,
    default: 1, required: true, integer: true, min: 1, max: 999999 }] : [])],
}));
