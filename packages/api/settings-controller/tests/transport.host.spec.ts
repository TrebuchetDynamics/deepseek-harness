import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { apply as applyConnection, inject as connectionInject } from '@deepseek-ai/dsh-client-connection'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import type { WebRoute, WebServer } from '@deepseek-ai/dsh-host-webserver'
import TypertGatewayService from '@deepseek-ai/dsh-api-gateway'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import SettingsController from '../src/index.ts'
import { MemorySettings } from '../../../settings/settings/tests/memory.ts'

function provideBrowserCredentials(ctx: Context): void {
  const records = new Map<unknown, unknown>()
  ctx.provide('credentials', {
    async modifyRecord(key: unknown, mutate: (current: unknown) => Promise<unknown>): Promise<unknown> {
      const current = records.get(key)
      const next = await mutate(current)
      if (next !== undefined) records.set(key, next)
      return next ?? current
    },
  } as never)
}

function fakeWebServer(routes: WebRoute[]): Pick<WebServer, 'register' | 'tapIndex' | 'port'> {
  return {
    register(route) {
      routes.push(route)
      return () => { routes.splice(routes.indexOf(route), 1) }
    },
    tapIndex: () => () => {},
    port: 0,
  }
}

async function serve(route: WebRoute): Promise<{ origin: string; close(): Promise<void> }> {
  const server = createServer((request, response) => { void route.handler(request, response) })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address() as AddressInfo
  return {
    origin: `http://127.0.0.1:${String(address.port)}`,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => {
        if (error === undefined) resolve()
        else reject(error)
      })
    }),
  }
}

function browserCookie(connection: HostConnectionHandle, origin: string): string {
  const target = new URL(connection.authenticatedUrl(origin))
  let cookie: string | undefined
  connection.authorizeIndex({
    method: 'GET',
    url: `${target.pathname}${target.search}`,
    headers: { host: target.host },
  }, {
    writeHead(_status, headers) { cookie = headers?.['set-cookie'] },
    end() {},
  })
  if (cookie === undefined) throw new Error('settings transport fixture did not receive an authentication cookie')
  return cookie.split(';', 1)[0] as string
}

describe('settings Remote Host transport', () => {
  it('delegates an authorized request and rejects an unauthorized request before the controller', async () => {
    const ctx = new Context()
    const routes: WebRoute[] = []
    provideBrowserCredentials(ctx)
    ctx.provide('webServer', fakeWebServer(routes) as WebServer)
    const connectionFiber = ctx.plugin({ inject: [...connectionInject], apply: applyConnection })
    await connectionFiber
    await ctx.plugin(TypertRegistry)
    const gatewayFiber = ctx.plugin(TypertGatewayService)
    await gatewayFiber
    await ctx.plugin(MemorySettings)
    ctx.settings.register('ui-test', z.object({ enabled: z.boolean().default(true) }))
    const controllerFiber = ctx.plugin(SettingsController)
    await controllerFiber
    const describe = vi.spyOn(ctx.settings, 'describe')
    const server = await serve(routes[0] as WebRoute)

    try {
      const request = JSON.stringify({
        type: 'client-request',
        rpcId: 'settings-describe',
        method: 'settings/describe',
        payload: { args: {} },
      })
      const unauthorized = await fetch(`${server.origin}/api/settings/describe`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: request,
      })
      expect(unauthorized.status).toBe(401)
      expect(describe).not.toHaveBeenCalled()

      const authorized = await fetch(`${server.origin}/api/settings/describe`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          cookie: browserCookie(ctx.connection, server.origin),
        },
        body: request,
      })
      expect(authorized.status).toBe(200)
      await expect(authorized.json()).resolves.toMatchObject({
        type: 'server-response',
        rpcId: 'settings-describe',
        result: {
          ok: true,
          value: { writable: true, namespaces: [{ ns: 'ui-test', value: { enabled: true } }] },
        },
      })
      expect(describe).toHaveBeenCalledWith({ redactSecrets: true })
    } finally {
      await server.close()
      await controllerFiber.dispose()
      await gatewayFiber.dispose()
      await connectionFiber.dispose()
    }
  })
})
