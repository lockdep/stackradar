import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { reloadIfSessionLost, resetSessionLostForTests } from './session-lost'

const reload = vi.fn()
const fetchMock = vi.fn()

beforeEach(() => {
    resetSessionLostForTests()
    reload.mockReset()
    fetchMock.mockReset()
    vi.stubGlobal('window', { location: { reload } })
    vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
    vi.unstubAllGlobals()
})

const sessionResponse = (body: unknown, ok = true) =>
    Promise.resolve({ ok, json: () => Promise.resolve(body) })

describe('reloadIfSessionLost', () => {
    it('reloads when the session endpoint reports no user', async () => {
        fetchMock.mockReturnValue(sessionResponse(null))
        await expect(reloadIfSessionLost()).resolves.toBe(true)
        expect(reload).toHaveBeenCalledTimes(1)
        expect(fetchMock).toHaveBeenCalledWith('/api/auth/session', { cache: 'no-store' })
    })

    it('does not reload while a session is still there', async () => {
        fetchMock.mockReturnValue(sessionResponse({ user: { id: 'u1' } }))
        await expect(reloadIfSessionLost()).resolves.toBe(false)
        expect(reload).not.toHaveBeenCalled()
    })

    it('treats a failed session check as "still signed in" rather than looping', async () => {
        fetchMock.mockRejectedValue(new Error('network'))
        await expect(reloadIfSessionLost()).resolves.toBe(false)
        fetchMock.mockReturnValue(sessionResponse({}, false))
        await expect(reloadIfSessionLost()).resolves.toBe(false)
        expect(reload).not.toHaveBeenCalled()
    })

    it('folds concurrent callers into one check and one reload', async () => {
        fetchMock.mockReturnValue(sessionResponse(null))
        const results = await Promise.all([reloadIfSessionLost(), reloadIfSessionLost(), reloadIfSessionLost()])
        expect(results).toEqual([true, true, true])
        expect(fetchMock).toHaveBeenCalledTimes(1)
        expect(reload).toHaveBeenCalledTimes(1)
    })

    it('is a no-op outside the browser', async () => {
        vi.stubGlobal('window', undefined)
        await expect(reloadIfSessionLost()).resolves.toBe(false)
        expect(fetchMock).not.toHaveBeenCalled()
    })
})
