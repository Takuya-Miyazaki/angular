/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

// tslint:disable:no-duplicate-imports
import {EventContract} from '@angular/core/primitives/event-dispatch';
import {Attribute} from '@angular/core/primitives/event-dispatch';
import {InjectionToken, Injector} from './di';
import {RElement} from './render3/interfaces/renderer_dom';
import {
  BLOCK_ELEMENT_MAP,
  EVENT_REPLAY_ENABLED_DEFAULT,
  IS_EVENT_REPLAY_ENABLED,
} from './hydration/tokens';
import {OnDestroy} from './interface/lifecycle_hooks';

export const BLOCKNAME_ATTRIBUTE = 'ngb';

declare global {
  interface Element {
    __jsaction_fns: Map<string, Function[]> | undefined;
  }
}

export function invokeRegisteredDelegationListeners(event: Event) {
  const handlerFns = (event.currentTarget as Element)?.__jsaction_fns?.get(event.type);
  if (!handlerFns) {
    return;
  }
  for (const handler of handlerFns) {
    handler(event);
  }
}

export function setJSActionAttributes(
  nativeElement: Element,
  eventTypes: string[],
  parentDeferBlockId: string | null = null,
) {
  if (!eventTypes.length || nativeElement.nodeType !== Node.ELEMENT_NODE) {
    return;
  }
  const existingAttr = nativeElement.getAttribute(Attribute.JSACTION);
  // we dedupe cases where hydrate triggers are used as it's possible that
  // someone may have added an event binding to the root node that matches what the
  // hydrate trigger adds.
  const parts = eventTypes.reduce((prev, curr) => {
    // if there is no existing attribute OR it's not in the existing one, we need to add it
    return (existingAttr?.indexOf(curr) ?? -1) === -1 ? prev + curr + ':;' : prev;
  }, '');
  //  This is required to be a module accessor to appease security tests on setAttribute.
  nativeElement.setAttribute(Attribute.JSACTION, `${existingAttr ?? ''}${parts}`);

  const blockName = parentDeferBlockId ?? '';
  if (blockName !== '' && parts.length > 0) {
    nativeElement.setAttribute(BLOCKNAME_ATTRIBUTE, blockName);
  }
}

export const sharedStashFunction = (rEl: RElement, eventType: string, listenerFn: Function) => {
  const el = rEl as unknown as Element;
  const eventListenerMap = el.__jsaction_fns ?? new Map();
  const eventListeners = eventListenerMap.get(eventType) ?? [];
  eventListeners.push(listenerFn);
  eventListenerMap.set(eventType, eventListeners);
  el.__jsaction_fns = eventListenerMap;
};

export const sharedMapFunction = (rEl: RElement, jsActionMap: Map<string, Set<Element>>) => {
  let blockName = rEl.getAttribute(BLOCKNAME_ATTRIBUTE) ?? '';
  const el = rEl as unknown as Element;
  const blockSet = jsActionMap.get(blockName) ?? new Set<Element>();
  if (!blockSet.has(el)) {
    blockSet.add(el);
  }
  jsActionMap.set(blockName, blockSet);
};

export function removeListenersFromBlocks(blockNames: string[], injector: Injector) {
  let blockList: Element[] = [];
  const jsActionMap = injector.get(BLOCK_ELEMENT_MAP);
  for (let blockName of blockNames) {
    if (jsActionMap.has(blockName)) {
      blockList = [...blockList, ...jsActionMap.get(blockName)!];
    }
  }
  const replayList = new Set(blockList);
  replayList.forEach(removeListeners);
}

export const removeListeners = (el: Element) => {
  el.removeAttribute(Attribute.JSACTION);
  el.removeAttribute(BLOCKNAME_ATTRIBUTE);
  el.__jsaction_fns = undefined;
};

export interface EventContractDetails {
  instance?: EventContract;
}

export const JSACTION_EVENT_CONTRACT = new InjectionToken<EventContractDetails>(
  ngDevMode ? 'EVENT_CONTRACT_DETAILS' : '',
  {
    providedIn: 'root',
    factory: () => ({}),
  },
);