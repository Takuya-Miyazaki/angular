/**
 * @license
 * Copyright Google LLC All Rights Reserved.
 *
 * Use of this source code is governed by an MIT-style license that can be
 * found in the LICENSE file at https://angular.dev/license
 */

import {
  isEarlyEventType,
  isCaptureEventType,
  EventContractContainer,
  EventContract,
  EventDispatcher,
  registerDispatcher,
  getAppScopedQueuedEventInfos,
  clearAppScopedEarlyEventContract,
  EventPhase,
} from '@angular/core/primitives/event-dispatch';

import {APP_BOOTSTRAP_LISTENER, ApplicationRef, whenStable} from '../application/application_ref';
import {ENVIRONMENT_INITIALIZER, Injector} from '../di';
import {inject} from '../di/injector_compatibility';
import {Provider} from '../di/interface/provider';
import {setStashFn} from '../render3/instructions/listener';
import {RElement} from '../render3/interfaces/renderer_dom';
import {CLEANUP, LView, TView} from '../render3/interfaces/view';
import {isPlatformBrowser} from '../render3/util/misc_utils';
import {unwrapRNode} from '../render3/util/view_utils';

import {BLOCK_ELEMENT_MAP, EVENT_REPLAY_ENABLED_DEFAULT, IS_EVENT_REPLAY_ENABLED} from './tokens';
import {
  sharedStashFunction,
  sharedMapFunction,
  BLOCKNAME_ATTRIBUTE,
  EventContractDetails,
  JSACTION_EVENT_CONTRACT,
  removeListenersFromBlocks,
} from '../event_delegation_utils';
import {APP_ID} from '../application/application_tokens';
import {performanceMarkFeature} from '../util/performance';
import {hydrateFromBlockName, findFirstKnownParentDeferBlock} from './blocks';
import {DeferBlock, DeferBlockTrigger, HydrateTriggerDetails} from '../defer/interfaces';
import {triggerAndWaitForCompletion} from '../defer/instructions';
import {cleanupDehydratedViews, cleanupLContainer} from './cleanup';
import {hoverEventNames, interactionEventNames} from '../defer/dom_triggers';

/** Apps in which we've enabled event replay.
 *  This is to prevent initializing event replay more than once per app.
 */
const appsWithEventReplay = new WeakSet<ApplicationRef>();

/**
 * A set of in progress hydrating blocks
 */
let hydratingBlocks = new Set<string>();

/**
 * A list of block events that need to be replayed
 */
let blockEventQueue: {event: Event; currentTarget: Element}[] = [];

/**
 * Determines whether Event Replay feature should be activated on the client.
 */
function shouldEnableEventReplay(injector: Injector) {
  return injector.get(IS_EVENT_REPLAY_ENABLED, EVENT_REPLAY_ENABLED_DEFAULT);
}

/**
 * Returns a set of providers required to setup support for event replay.
 * Requires hydration to be enabled separately.
 */
export function withEventReplay(): Provider[] {
  return [
    {
      provide: IS_EVENT_REPLAY_ENABLED,
      useFactory: () => {
        let isEnabled = true;
        if (isPlatformBrowser()) {
          // Note: globalThis[CONTRACT_PROPERTY] may be undefined in case Event Replay feature
          // is enabled, but there are no events configured in this application, in which case
          // we don't activate this feature, since there are no events to replay.
          const appId = inject(APP_ID);
          isEnabled = !!window._ejsas?.[appId];
        }
        if (isEnabled) {
          performanceMarkFeature('NgEventReplay');
        }
        return isEnabled;
      },
    },
    {
      provide: ENVIRONMENT_INITIALIZER,
      useValue: () => {
        const injector = inject(Injector);
        const appRef = injector.get(ApplicationRef);
        if (!appsWithEventReplay.has(appRef)) {
          const jsActionMap = inject(BLOCK_ELEMENT_MAP);
          if (isPlatformBrowser(injector) && shouldEnableEventReplay(injector)) {
            setStashFn((rEl: RElement, eventName: string, listenerFn: VoidFunction) => {
              sharedStashFunction(rEl, eventName, listenerFn);
              sharedMapFunction(rEl, jsActionMap);
            });
          }
        }
      },
      multi: true,
    },
    {
      provide: APP_BOOTSTRAP_LISTENER,
      useFactory: () => {
        if (isPlatformBrowser()) {
          const injector = inject(Injector);
          const appRef = inject(ApplicationRef);
          return () => {
            if (!shouldEnableEventReplay(injector)) {
              return;
            }

            if (!appsWithEventReplay.has(appRef)) {
              appsWithEventReplay.add(appRef);
              appRef.onDestroy(() => appsWithEventReplay.delete(appRef));

              // Kick off event replay logic once hydration for the initial part
              // of the application is completed. This timing is similar to the unclaimed
              // dehydrated views cleanup timing.
              whenStable(appRef).then(() => {
                const eventContractDetails = injector.get(JSACTION_EVENT_CONTRACT);
                initEventReplay(eventContractDetails, injector);
                removeListenersFromBlocks([''], injector);
              });
            }
          };
        }
        return () => {}; // noop for the server code
      },
      multi: true,
    },
  ];
}

const initEventReplay = (eventDelegation: EventContractDetails, injector: Injector) => {
  const appId = injector.get(APP_ID);
  // This is set in packages/platform-server/src/utils.ts
  const earlyJsactionData = window._ejsas![appId]!;
  const eventContract = (eventDelegation.instance = new EventContract(
    new EventContractContainer(earlyJsactionData.c),
  ));
  for (const et of earlyJsactionData.et) {
    eventContract.addEvent(et);
  }
  for (const et of earlyJsactionData.etc) {
    eventContract.addEvent(et);
  }
  const eventInfos = getAppScopedQueuedEventInfos(appId);
  eventContract.replayEarlyEventInfos(eventInfos);
  clearAppScopedEarlyEventContract(appId);
  const dispatcher = new EventDispatcher((event) => {
    invokeRegisteredReplayListeners(injector, event, event.currentTarget as Element);
  });
  registerDispatcher(eventContract, dispatcher);
};

/**
 * Extracts information about all DOM events (added in a template) registered on elements in a give
 * LView. Maps collected events to a corresponding DOM element (an element is used as a key).
 */
export function collectDomEventsInfo(
  tView: TView,
  lView: LView,
  eventTypesToReplay: {regular: Set<string>; capture: Set<string>},
): Map<Element, string[]> {
  const domEventsInfo = new Map<Element, string[]>();
  const lCleanup = lView[CLEANUP];
  const tCleanup = tView.cleanup;
  if (!tCleanup || !lCleanup) {
    return domEventsInfo;
  }
  for (let i = 0; i < tCleanup.length; ) {
    const firstParam = tCleanup[i++];
    const secondParam = tCleanup[i++];
    if (typeof firstParam !== 'string') {
      continue;
    }
    const eventType = firstParam;
    if (!isEarlyEventType(eventType)) {
      continue;
    }
    if (isCaptureEventType(eventType)) {
      eventTypesToReplay.capture.add(eventType);
    } else {
      eventTypesToReplay.regular.add(eventType);
    }
    const listenerElement = unwrapRNode(lView[secondParam]) as any as Element;
    i++; // move the cursor to the next position (location of the listener idx)
    const useCaptureOrIndx = tCleanup[i++];
    // if useCaptureOrIndx is boolean then report it as is.
    // if useCaptureOrIndx is positive number then it in unsubscribe method
    // if useCaptureOrIndx is negative number then it is a Subscription
    const isDomEvent = typeof useCaptureOrIndx === 'boolean' || useCaptureOrIndx >= 0;
    if (!isDomEvent) {
      continue;
    }
    if (!domEventsInfo.has(listenerElement)) {
      domEventsInfo.set(listenerElement, [eventType]);
    } else {
      domEventsInfo.get(listenerElement)!.push(eventType);
    }
  }
  return domEventsInfo;
}

function invokeListeners(event: Event, currentTarget: Element | null) {
  const handlerFns = currentTarget?.__jsaction_fns?.get(event.type);
  if (!handlerFns) {
    return;
  }
  for (const handler of handlerFns) {
    handler(event);
  }
}

export function invokeRegisteredReplayListeners(
  injector: Injector,
  event: Event,
  currentTarget: Element | null,
) {
  const blockName = (currentTarget && currentTarget.getAttribute(BLOCKNAME_ATTRIBUTE)) ?? '';
  if (/d\d+/.test(blockName)) {
    hydrateAndInvokeBlockListeners(blockName, injector, event, currentTarget!);
  } else if (event.eventPhase === EventPhase.REPLAY) {
    invokeListeners(event, currentTarget);
  }
}

async function hydrateAndInvokeBlockListeners(
  blockName: string,
  injector: Injector,
  event: Event,
  currentTarget: Element,
) {
  blockEventQueue.push({event, currentTarget});
  if (!hydratingBlocks.has(blockName)) {
    hydratingBlocks.add(blockName);
    await triggerBlockHydration(injector, blockName, fetchAndRenderDeferBlock);
    hydratingBlocks.delete(blockName);
  }
}

export async function fetchAndRenderDeferBlock(deferBlock: DeferBlock): Promise<DeferBlock> {
  await triggerAndWaitForCompletion(deferBlock);
  return deferBlock;
}

async function triggerBlockHydration(
  injector: Injector,
  blockName: string,
  onTriggerFn: (deferBlock: any) => void,
) {
  // grab the list of dehydrated blocks and queue them up
  const {dehydratedBlocks} = findFirstKnownParentDeferBlock(blockName, injector);
  for (let block of dehydratedBlocks) {
    hydratingBlocks.add(block);
  }
  const {deferBlock, hydratedBlocks} = await hydrateFromBlockName(injector, blockName, onTriggerFn);
  if (deferBlock !== null) {
    hydratedBlocks.add(blockName);
    const appRef = injector.get(ApplicationRef);
    await appRef.whenStable();
    replayQueuedBlockEvents(hydratedBlocks, injector);
    cleanupLContainer(deferBlock.lContainer);
  }
}

function replayQueuedBlockEvents(hydratedBlocks: Set<string>, injector: Injector) {
  // clone the queue
  const queue = [...blockEventQueue];
  // empty it
  blockEventQueue = [];
  for (let {event, currentTarget} of queue) {
    const blockName = currentTarget.getAttribute(BLOCKNAME_ATTRIBUTE)!;
    if (hydratedBlocks.has(blockName)) {
      invokeListeners(event, currentTarget);
    } else {
      // requeue events that weren't yet hydrated
      blockEventQueue.push({event, currentTarget});
    }
  }
  cleanupDehydratedViews(injector.get(ApplicationRef));
  removeListenersFromBlocks([...hydratedBlocks], injector);
}

export function convertHydrateTriggersToJsAction(
  triggers: Map<DeferBlockTrigger, HydrateTriggerDetails | null> | null,
): string[] {
  let actionList: string[] = [];
  if (triggers !== null) {
    if (triggers.has(DeferBlockTrigger.Hover)) {
      actionList.push(...hoverEventNames);
    }
    if (triggers.has(DeferBlockTrigger.Interaction)) {
      actionList.push(...interactionEventNames);
    }
  }
  return actionList;
}

export function appendBlocksToJSActionMap(el: RElement, injector: Injector) {
  const jsActionMap = injector.get(BLOCK_ELEMENT_MAP);
  sharedMapFunction(el, jsActionMap);
}

function gatherDeferBlocksByJSActionAttribute(doc: Document): Set<HTMLElement> {
  const jsactionNodes = doc.body.querySelectorAll('[jsaction]');
  const blockMap = new Set<HTMLElement>();
  for (let node of jsactionNodes) {
    const attr = node.getAttribute('jsaction');
    const blockId = node.getAttribute('ngb');
    const eventTypes = [...hoverEventNames.join(':;'), ...interactionEventNames.join(':;')].join(
      '|',
    );
    if (attr?.match(eventTypes) && blockId !== null) {
      blockMap.add(node as HTMLElement);
    }
  }
  return blockMap;
}

export function appendDeferBlocksToJSActionMap(doc: Document, injector: Injector) {
  const blockMap = gatherDeferBlocksByJSActionAttribute(doc);
  for (let rNode of blockMap) {
    appendBlocksToJSActionMap(rNode as RElement, injector);
  }
}