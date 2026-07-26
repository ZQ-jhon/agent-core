import { useSyncExternalStore } from 'react'
import type { A2UIFormController, A2UIFormState } from './form-state.ts'

/** React adapter for the framework-independent A2UI form controller. */
export function useA2UIFormState(controller: A2UIFormController): A2UIFormState {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
}
