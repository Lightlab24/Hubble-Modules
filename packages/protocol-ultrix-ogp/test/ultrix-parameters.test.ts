import { describe, expect, it } from 'vitest'

import {
  DEFAULT_OGP_PANEL_ID,
  READ_OIDS,
  assertSafeRouteControllerIdentityWrite,
  assertSafeRouteWrite,
  createRouteControllerIdentityWrite,
  createRouteWrite,
  parseCatalogElement,
  parseDestinationStatus,
  parseLevels,
  routeElement,
  routeOid,
  routeValue,
  validateDeviceParameterDescriptors,
} from '../src/ultrix-parameters.js'

describe('Ultrix OGP parameters', () => {
  it('contains only the six read OIDs used by the focused router client', () => {
    expect(READ_OIDS).toEqual([
      'params.basicsources',
      'params.basicdests',
      'params.levels',
      'params.statusByDestination',
      'params.controlready',
      'params.takeError',
    ])
  })

  it('converts one-based router addresses to the exact zero-based route write', () => {
    expect(routeOid(40)).toBe('params.statusByDestination.39.inputstatus')
    expect(routeElement(1)).toBe(0)
    expect(routeValue(25)).toBe(24)
    expect(createRouteWrite({ source: 25, destination: 40, level: 1 })).toEqual({
      oid: 'params.statusByDestination.39.inputstatus',
      element: true,
      index: 0,
      value: 24,
    })
  })

  it('creates only the Ross route-controller identity preamble for lockowner element zero', () => {
    expect(DEFAULT_OGP_PANEL_ID).toBe(1999)
    expect(
      createRouteControllerIdentityWrite({
        panelId: DEFAULT_OGP_PANEL_ID,
      }),
    ).toEqual({
      oid: 'params.statusByDestination.0.lockowner',
      element: true,
      index: 0,
      value: 1999,
    })
    expect(() => createRouteControllerIdentityWrite({ panelId: 0 })).toThrow(/panelId/u)
  })

  it('rejects out-of-range values and every non-route write path', () => {
    expect(() => routeOid(0)).toThrow(/destination/iu)
    expect(() => routeElement(257)).toThrow(/level/iu)
    expect(() => routeValue(65_537)).toThrow(/source/iu)
    expect(() =>
      assertSafeRouteWrite({
        oid: 'params.statusByDestination.0.lockstatus',
        element: true,
        index: 0,
        value: 1,
      }),
    ).toThrow(/unsafe/iu)
    expect(() =>
      assertSafeRouteWrite({
        oid: 'params.database',
        element: true,
        index: 0,
        value: 1,
      }),
    ).toThrow(/unsafe/iu)
    expect(() =>
      assertSafeRouteControllerIdentityWrite({
        oid: 'params.statusByDestination.0.lockowner',
        element: true,
        index: 1,
        value: 1999,
      }),
    ).toThrow(/unsafe/iu)
    expect(() =>
      assertSafeRouteControllerIdentityWrite({
        oid: 'params.statusByDestination.0.lockstatus',
        element: true,
        index: 0,
        value: 1999,
      }),
    ).toThrow(/unsafe/iu)
    expect(() =>
      assertSafeRouteControllerIdentityWrite({
        oid: 'params.statusByDestination.1.lockowner',
        element: true,
        index: 0,
        value: 1999,
      }),
    ).toThrow(/unsafe/iu)
    expect(() =>
      assertSafeRouteControllerIdentityWrite({
        oid: 'params.statusByDestination.0.lockowner',
        element: true,
        index: 0,
        value: 0,
      }),
    ).toThrow(/unsafe/iu)
  })

  it('parses bounded source and destination catalog elements as one-based labels', () => {
    expect(
      parseCatalogElement('params.basicsources', 0, {
        id: 0,
        name: 'ADAM',
        tally: '',
        description: 'SRC 01',
      }),
    ).toEqual({ address: 1, label: 'ADAM', description: 'SRC 01' })
    expect(
      parseCatalogElement('params.basicdests', 151, {
        id: 151,
        name: 'DST 152',
        redirect: 0,
        description: '',
      }),
    ).toEqual({ address: 152, label: 'DST 152', description: null })
    expect(() =>
      parseCatalogElement('params.basicsources', 1, { id: 9, name: 'mismatch' }),
    ).toThrow(/does not match/iu)
    expect(() => parseCatalogElement('params.levels', 0, {})).toThrow(/catalog OID/iu)
  })

  it('parses and bounds the verified 17-level structure', () => {
    const values = Array.from({ length: 20 }, (_, index) => ({
      id: index,
      name: index === 0 ? 'VID' : `AUD ${String(index)}`,
    }))

    expect(parseLevels(values, 17)).toHaveLength(17)
    expect(parseLevels(values, 17).at(0)).toEqual({ level: 1, label: 'VID' })
    expect(parseLevels(values, 17).at(-1)).toEqual({ level: 17, label: 'AUD 16' })
    expect(() => parseLevels([{ id: 2, name: 'bad' }], 1)).toThrow(/level id/iu)
  })

  it('normalizes a whole destination row atomically and maps 65536 to unrouted', () => {
    expect(
      parseDestinationStatus(
        39,
        {
          inputstatus: [24, 25, 65_536],
          lockstatus: [0, 0, 0],
          lockowner: [0, 0, 0],
          sessionid: 'default',
        },
        { levels: 3, sourceLimit: 152, destinationLimit: 152 },
      ),
    ).toEqual([
      { destination: 40, level: 1, source: 25 },
      { destination: 40, level: 2, source: 26 },
      { destination: 40, level: 3, source: null },
    ])
    expect(
      parseDestinationStatus(
        152,
        { inputstatus: [0] },
        { levels: 1, sourceLimit: 152, destinationLimit: 152 },
      ),
    ).toEqual([])
    expect(() =>
      parseDestinationStatus(
        0,
        { inputstatus: [0, 1] },
        { levels: 3, sourceLimit: 152, destinationLimit: 152 },
      ),
    ).toThrow(/at least 3 levels/iu)
  })

  it('treats sources outside the configured catalog as unknown', () => {
    expect(
      parseDestinationStatus(
        0,
        { inputstatus: [152] },
        { levels: 1, sourceLimit: 152, destinationLimit: 152 },
      ),
    ).toEqual([{ destination: 1, level: 1, source: null }])
  })

  it('validates the exact writable status descriptor and fails closed on bad types', () => {
    const valid = {
      '_d_params.statusByDestination': {
        oid: 'params.statusByDestination',
        type: 'STRUCT_ARRAY',
        value: [],
        constraint: { type: 'STRUCT', templateoid: 'types.statusByDestination' },
      },
      '_d_types.statusByDestination': {
        oid: 'types.statusByDestination',
        type: 'STRUCT',
        value: {
          _d_inputstatus: { name: 'Input Status', type: 'INT16_ARRAY', value: [0] },
        },
      },
      'params.controlready': {
        oid: 'params.controlready',
        type: 'INT16',
        value: 1,
      },
      'params.takeError': {
        oid: 'params.takeError',
        type: 'STRING',
        value: 'None|Timestamp',
      },
    }

    expect(validateDeviceParameterDescriptors(valid)).toEqual({
      controlReady: true,
      takeError: 'None|Timestamp',
      statusRows: [],
    })
    expect(() =>
      validateDeviceParameterDescriptors({
        ...valid,
        '_d_params.statusByDestination': {
          oid: 'params.statusByDestination',
          type: 'STRING',
        },
      }),
    ).toThrow(/STRUCT_ARRAY/iu)
    expect(() =>
      validateDeviceParameterDescriptors({
        ...valid,
        '_d_types.statusByDestination': {
          oid: 'types.statusByDestination',
          type: 'STRUCT',
          value: { _d_inputstatus: { type: 'INT16_ARRAY' }, _d_lockstatus: {} },
        },
      }),
    ).not.toThrow()
  })
})
