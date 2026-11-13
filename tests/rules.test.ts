import { describe, expect, it } from 'vitest';
import { blockersOf, city, clampCounter, eligibleCarriers, laneBenchmark, normalizeOrder, pickSlot, slotOk } from '@/lib/domain/rules';
import { CARRIERS, SLOTS } from '@/lib/tools/data';

describe('dock slots', () => {
  it('accepts a pickup the day before the deadline, or very early on the day', () => {
    expect(slotOk({ dock: 'D', window: '', day: 18, hour: 15 }, 'Thu 19 Nov')).toBe(true);
    expect(slotOk({ dock: 'D', window: '', day: 19, hour: 5 }, 'Thu 19 Nov')).toBe(true);
    expect(slotOk({ dock: 'D', window: '', day: 19, hour: 14 }, 'Thu 19 Nov')).toBe(false);
  });

  it('picks the latest slot that still meets the deadline', () => {
    expect(SLOTS[pickSlot(SLOTS, 'Thu 19 Nov, before 12:00')].window).toBe('Wed 18 Nov, 15:00–16:00');
    expect(SLOTS[pickSlot(SLOTS, 'Tue 17 Nov')].window).toBe('Tue 17 Nov, 05:00–06:00');
  });

  it('takes the first slot when there is no deadline', () => {
    expect(pickSlot(SLOTS, 'Not stated')).toBe(0);
  });
});

describe('orders', () => {
  it('records what the email did not say instead of guessing', () => {
    const o = normalizeOrder({ destination: 'somewhere up north' }, 'Test request');
    expect(o.pallets).toBe(0);
    expect(o.destination).toBe('somewhere up north'); // kept as written, but not a served lane
    expect(o.missing).toEqual(['Pallet count', 'Delivery city', 'Delivery date']);
    expect(blockersOf(o)).toEqual(['pallet count', 'delivery city']);
  });

  it('maps lane names and the JB shorthand', () => {
    expect(city('our JB service centre')).toBe('Johor Bahru');
    expect(city('Kuala Terengganu cold store')).toBe('Kuala Terengganu');
    expect(city('up north')).toBeNull();
  });

  it('does not double-report a field the model already flagged', () => {
    const o = normalizeOrder({ pallets: 4, destination: 'Ipoh', missing: ['Delivery deadline'] }, 'X');
    expect(o.missing).toEqual(['Delivery deadline']);
  });
});

describe('carriers', () => {
  it('never asks a haulier with an expired APAD permit', () => {
    const { eligible, excluded } = eligibleCarriers(CARRIERS, 'ambient', ['Tail-lift']);
    expect(eligible.map(c => c.name)).toEqual(['Utara Haulage', 'Lebuhraya Express']);
    expect(excluded.map(c => c.name)).toEqual(['Semenanjung Freight']);
  });

  it('only sends reefers for chilled or frozen loads', () => {
    const { eligible } = eligibleCarriers(CARRIERS, 'chilled', []);
    expect(eligible.every(c => c.equipment.includes('Reefer'))).toBe(true);
  });

  it('keeps counter-offers between 88% and 100% of the quote', () => {
    expect(clampCounter(2000, 1000)).toBe(1760);
    expect(clampCounter(2000, 2600)).toBe(2000);
    expect(clampCounter(2000, 1900)).toBe(1900);
    expect(clampCounter(2000, undefined)).toBe(1860);
  });

  it('prices the lane benchmark from distance, temperature and truck size', () => {
    expect(laneBenchmark('Penang', 'ambient', 24)).toBe(2200);
    expect(laneBenchmark('Kuantan', 'chilled', 22)).toBe(1940);
  });
});
