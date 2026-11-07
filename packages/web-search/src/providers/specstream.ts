import * as z from 'zod'

import { WEB_SEARCH_PROVIDER_CATALOG } from '../catalog'
import { apiUrl, bearer, invalidResponse, protocolError, requestJson } from '../protocols/http'
import type { WebSearchProviderModule } from '../types'

// The Search API accepts a question of 1 to 2,000 characters.
const MAX_SEARCH_QUERY_LENGTH = 2000

const searchSchema = z.looseObject({
  data: z.looseObject({
    answer: z
      .looseObject({
        value: z.unknown(),
        page: z.string().nullish()
      })
      .nullish(),
    rows: z
      .array(
        z.looseObject({
          name: z.string().nullish(),
          page: z.string().nullish(),
          snippet: z.string().nullish()
        })
      )
      .default([]),
    sources: z
      .array(
        z.looseObject({
          url: z.string(),
          title: z.string().nullish(),
          site: z.string().nullish(),
          snippet: z.string().nullish()
        })
      )
      .default([])
  })
})

const extractSchema = z.looseObject({
  data: z.looseObject({
    results: z.array(
      z.looseObject({
        url: z.string(),
        status: z.string(),
        text: z.string().nullish(),
        title: z.string().nullish()
      })
    )
  })
})

function answerText(value: unknown): string {
  if (typeof value === 'string') return value.trim()
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return ''
}

export const specstream: WebSearchProviderModule = {
  metadata: WEB_SEARCH_PROVIDER_CATALOG.specstream,
  async execute(context) {
    const { call } = context
    if (call.capability === 'searchKeywords') {
      const params = new URLSearchParams({
        q: Array.from(call.input.trim()).slice(0, MAX_SEARCH_QUERY_LENGTH).join('')
      })
      const { data } = await requestJson(
        context,
        {
          url: `${apiUrl(context.apiHost, '/v1/web-search')}?${params}`,
          method: 'GET',
          headers: { Accept: 'application/json', ...bearer(context) }
        },
        searchSchema
      )
      const results: { title: string; content: string; url: string; sourceInput: string }[] = []
      const listed = new Set<string>()
      const snippets = new Map(data.sources.map((source) => [source.url, source.snippet?.trim() || '']))
      const answer = answerText(data.answer?.value)
      // The answer page leads, titled by the answer itself.
      if (answer && data.answer?.page) {
        listed.add(data.answer.page)
        results.push({
          title: answer,
          content: snippets.get(data.answer.page) || answer,
          url: data.answer.page,
          sourceInput: call.input
        })
      }
      for (const row of data.rows) {
        if (!row.page) continue
        listed.add(row.page)
        results.push({
          title: row.name?.trim() || row.page,
          content: row.snippet?.trim() || '',
          url: row.page,
          sourceInput: call.input
        })
      }
      for (const source of data.sources) {
        if (listed.has(source.url)) continue
        listed.add(source.url)
        results.push({
          title: source.title?.trim() || source.site?.trim() || source.url,
          content: source.snippet?.trim() || '',
          url: source.url,
          sourceInput: call.input
        })
      }
      return results.slice(0, call.config.maxResults)
    }
    const { data } = await requestJson(
      context,
      {
        url: apiUrl(context.apiHost, '/v1/extract'),
        method: 'POST',
        headers: { Accept: 'application/json', ...bearer(context) },
        body: { urls: [call.input.trim()], format: 'markdown' }
      },
      extractSchema
    )
    const page = data.results[0]
    if (!page) throw invalidResponse(context, 'empty_results', 'SpecStream Extract returned no results')
    if (page.status !== 'ok') {
      throw protocolError(context, `fetch_${page.status}`, `SpecStream Extract could not read the page: ${page.status}`)
    }
    const content = page.text?.trim() || ''
    if (!content) throw invalidResponse(context, 'empty_content', 'SpecStream Extract returned empty content')
    return [{ title: page.title?.trim() || call.input, content, url: call.input, sourceInput: call.input }]
  }
}
