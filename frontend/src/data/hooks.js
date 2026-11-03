/**
 * THE data hooks every screen imports. They are the demo-store versions (src/demo/hooks.js)
 * or the API versions (src/api/hooks.js), chosen once by VITE_DATA_SOURCE (src/data/source.js).
 * Both return the same shapes, so screens don't know where their data comes from.
 *
 * Dashboards are the exception in Phase 4A: they keep reading demo figures from
 * src/demo/hooks.js (useProposalRequests, useTasks, ...) and take only the identity from here.
 */
import * as demo from '../demo/hooks.js'
import * as server from '../api/hooks.js'
import { API_MODE } from './source.js'

const impl = API_MODE ? server : demo

export const useCurrentUser = impl.useCurrentUser
export const useUsers = impl.useUsers
export const useLookups = impl.useLookups
export const useTracker = impl.useTracker
export const useProposalRequest = impl.useProposalRequest
export const useRequestActions = impl.useRequestActions
export const useRequestForm = impl.useRequestForm
export const useProposalFileUpload = impl.useProposalFileUpload
export const useAllRequests = impl.useAllRequests
export const useOpportunities = impl.useOpportunities
export const useClients = impl.useClients
export const useClient = impl.useClient
export const useOpportunity = impl.useOpportunity
export const useConfig = impl.useConfig
export const useCreateClient = impl.useCreateClient
export const useClientActions = impl.useClientActions
export const useClientHistory = impl.useClientHistory
export const useCreateOpportunity = impl.useCreateOpportunity
export const useOpportunityActions = impl.useOpportunityActions
export const useTeam = impl.useTeam
export const useAccount = impl.useAccount
export const useCreateAccount = impl.useCreateAccount
export const useAccountActions = impl.useAccountActions
export const useRouting = impl.useRouting
export const useAnalyticsData = impl.useAnalyticsData
export const useLists = impl.useLists
export const useListActions = impl.useListActions
export const useWaitingActions = impl.useWaitingActions
export const useWaitingOnMe = impl.useWaitingOnMe
export const useConversation = impl.useConversation
export const useDetailsActions = impl.useDetailsActions
export const useEvents = impl.useEvents
export const useEvent = impl.useEvent
export const useEventActions = impl.useEventActions
export const useNotifications = impl.useNotifications
export const useReminders = impl.useReminders
export const useMarkRead = impl.useMarkRead
export const useNewCount = impl.useNewCount
export const useDataFixes = impl.useDataFixes

/**
 * Tasks are not in the backend yet, so they are SAMPLE data from the demo seed (labelled "sample
 * data" wherever they appear). In API mode their client references are mapped to the server's ids
 * (demo c-08 -> CL-0008; users and opportunities share ids). On the REAL database there are none:
 * sample tasks would otherwise sit next to real clients.
 */
export function useSampleTasks() {
  const res = demo.useTasks()
  const { dataKind } = impl.useCurrentUser()
  if (!API_MODE) return res
  if (dataKind === 'real') return { ...res, data: [] }
  const toServerId = (id) => id?.replace(/^c-(\d+)$/, (_, n) => `CL-${n.padStart(4, '0')}`) ?? null
  return { ...res, data: res.data.map((t) => ({ ...t, related: { ...t.related, clientId: toServerId(t.related.clientId) } })) }
}
export const useOccasions = impl.useOccasions
export const useRadar = impl.useRadar
export const useStaffing = impl.useStaffing
export const useToRate = impl.useToRate
export const useFacilitators = impl.useFacilitators
export const useFacilitator = impl.useFacilitator
export const useEventStaffing = impl.useEventStaffing
export const useScreen = impl.useScreen
export const useTodos = impl.useTodos
