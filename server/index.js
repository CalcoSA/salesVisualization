import 'dotenv/config'
import cors from 'cors'
import express from 'express'

const app = express()
const port = process.env.PORT || 3001
const apiBase = 'https://calco.callcenter-api.bitcubo.net'
const apiKey = process.env.CALLCENTER_API_KEY
const dashboardCache = new Map()
const dashboardRequests = new Map()
const pdvRequests = new Map()
const sellerCache = new Map()
const sellerRequests = new Map()
const excludedProductNames = new Set(['Bono de Regalo $50,000','Bono de Regalo $100,000','Bono de Regalo $200,000','Domicilio'])
let pdvCache = null

if (!apiKey) console.warn('CALLCENTER_API_KEY no está definida; las consultas protegidas fallarán.')

app.use(cors())
//Autenticación con la API de Callcenter
async function apiGet(path, params) {
  const query = new URLSearchParams(Object.entries(params).filter(([, value]) => value !== undefined && value !== ''))
  const response = await fetch(`${apiBase}${path}?${query}`, { headers: { 'X-API-Key': apiKey } })
  if (!response.ok) throw new Error(`Callcenter API respondió ${response.status}`)
  return response.json()
}
//Normalización de la lista de PDV para que tengan un formato consistente y se puedan filtrar correctamente
function normalizarPdvs(payload) {
  const sources = []
  if (Array.isArray(payload)) sources.push(...payload)
  if (payload && typeof payload === 'object') {
    const candidates = [payload.items, payload.data, payload.result, payload.results, payload.list, payload.records]
    candidates.forEach((candidate) => {
      if (Array.isArray(candidate)) sources.push(...candidate)
    })
    if (!sources.length && typeof payload.nombre === 'string') sources.push(payload)
  }

  const normalized = sources.map((item) => {
    if (typeof item === 'string') return { nombre: item }
    if (item && typeof item === 'object') return { nombre: item.nombre || item.name || item.pdv || item.dimension || item.id, ...item }
    return null
  }).filter(Boolean)

  return normalized.filter((item, index, array) => {
    const key = String(item.nombre || item.id || '').trim().toLowerCase()
    return key && array.findIndex((candidate) => String(candidate.nombre || candidate.id || '').trim().toLowerCase() === key) === index
  })
}
//Extrae la lista de items desde un payload
function getItems(payload) {
  if (Array.isArray(payload)) return payload
  if (!payload || typeof payload !== 'object') return []
  const candidates = [payload.items, payload.data, payload.result, payload.results, payload.records]
  return candidates.find(Array.isArray) || []
}
//Verifica si un nombre de producto está en la lista de productos excluidos
function isExcludedProductName(name) {
  const normalized = String(name || '').replace(/\s+/g, ' ').trim()
  if (!normalized) return true
  return [...excludedProductNames].some((excluded) => excluded.toLowerCase() === normalized.toLowerCase())
}
//Filtra los productos excluidos de una lista de items
function excludeGiftProducts(items = []) {
  return items.filter((item) => {
    const name = item?.dimension || item?.nombre || ''
    return !isExcludedProductName(name)
  })
}
//Obtiene todos los pedidos de la API de Callcenter, paginando si es necesario
async function getAllOrders(filters) {
  const pageSize = 1000
  const items = []
  let offset = 0

  while (true) {
    const payload = await apiGet('/pedidos', { ...filters, limit: pageSize, offset })
    const page = getItems(payload)
    items.push(...page)
    if (page.length < pageSize) break
    offset += pageSize
  }

  const seenOrderIds = new Set()
  const uniqueItems = items.filter((item) => {
    if (item?.id === undefined || item?.id === null) return true
    const id = String(item.id)
    if (seenOrderIds.has(id)) return false
    seenOrderIds.add(id)
    return true
  })

  return { items: uniqueItems }
}
//Endpoint para obtener los datos del dashboard, con caching y manejo de requests compartidos(opotimización para evitar múltiples requests a la API de Callcenter)
app.get('/api/dashboard', async (request, response) => {
  const { desde, hasta, pdv, vendedor } = request.query
  if (!desde || !hasta) return response.status(400).json({ message: 'desde y hasta son obligatorios' })
  const sellerId = vendedor === undefined || vendedor === '' ? undefined : Number(vendedor)
  if (sellerId !== undefined && (!Number.isSafeInteger(sellerId) || sellerId <= 0)) {
    return response.status(400).json({ message: 'vendedora debe ser un ID entero positivo' })
  }
  const cacheKey = JSON.stringify({ desde, hasta, pdv: pdv || '', vendedor: sellerId || '' })
  const cached = dashboardCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return response.json(cached.data)
  const filters = { desde, hasta, pdv, vendedor: sellerId }
  let sharedRequest = dashboardRequests.get(cacheKey)
  if (!sharedRequest) {
    sharedRequest = Promise.all([
      apiGet('/stats/ventas/resumen', filters),
      apiGet('/stats/ventas/por-periodo', { ...filters, granularidad: 'dia', incluir_totales: true }),
      apiGet('/stats/ventas/por-producto', { ...filters, top: 12 }),
      apiGet('/stats/ventas/por-vendedor', { desde, hasta, pdv, top: sellerId ? 200 : 4 }),
      apiGet('/stats/ventas/por-hora', { ...filters, agrupar_por_dia_semana: false }),
      getAllOrders(filters),
    ]).then(([summary, series, productRanking, sellerRanking, hourly, orders]) => {
      const data = {
        summary,
        series,
        productRanking: { ...productRanking, items: excludeGiftProducts(productRanking?.items || []) },
        sellerRanking: sellerId
          ? { ...sellerRanking, items: (sellerRanking?.items || []).filter((item) => String(item.cod_dimension) === String(sellerId)) }
          : sellerRanking,
        hourly,
        orders,
      }
      dashboardCache.set(cacheKey, { data, expiresAt: Date.now() + 60_000 })
      return data
    }).finally(() => dashboardRequests.delete(cacheKey))
    dashboardRequests.set(cacheKey, sharedRequest)
  }
  try {
    response.json(await sharedRequest)
  } catch (error) {
    response.status(502).json({ message: error instanceof Error ? error.message : 'No se pudo consultar la API' })
  }
})
// Entrega vendedoras con actividad en el rango de fechas y PDV seleccionados.
app.get('/api/vendedoras', async (request, response) => {
  const { desde, hasta, pdv } = request.query
  if (!desde || !hasta) return response.status(400).json({ message: 'desde y hasta son obligatorios' })
  const cacheKey = JSON.stringify({ desde, hasta, pdv: pdv || '' })
  const cached = sellerCache.get(cacheKey)
  if (cached && cached.expiresAt > Date.now()) return response.json(cached.data)
  let sharedRequest = sellerRequests.get(cacheKey)
  if (!sharedRequest) {
    sharedRequest = apiGet('/stats/ventas/por-vendedor', { desde, hasta, pdv, top: 200 })
      .then((payload) => getItems(payload)
        .filter((item) => item?.cod_dimension !== undefined && item?.cod_dimension !== null && item?.dimension)
        .map((item) => ({
          id: String(item.cod_dimension),
          nombre: String(item.dimension).trim(),
          num_pedidos: Number(item.num_pedidos || 0),
          ticket_promedio: String(item.ticket_promedio || ''),
          total: String(item.total || ''),
        }))
        .filter((seller) => seller.nombre)
        .sort((first, second) => first.nombre.localeCompare(second.nombre, 'es')))
      .then((items) => {
        const uniqueItems = items.filter((seller, index) => items.findIndex((candidate) => candidate.id === seller.id) === index)
        sellerCache.set(cacheKey, { data: uniqueItems, expiresAt: Date.now() + 5 * 60_000 })
        return uniqueItems
      })
      .finally(() => sellerRequests.delete(cacheKey))
    sellerRequests.set(cacheKey, sharedRequest)
  }
  try {
    response.json(await sharedRequest)
  } catch (error) {
    response.status(502).json({ message: error instanceof Error ? error.message : 'No se pudieron consultar las vendedoras' })
  }
})
//Endpoint para obtener la lista de PDV
app.get('/api/pdvs', async (request, response) => {
  try {
    const desde = request.query.desde || '2026-05-01'
    const hasta = request.query.hasta || '2026-05-31'
    const cacheKey = `${desde}:${hasta}`
    if (pdvCache?.key === cacheKey && pdvCache.expiresAt > Date.now()) return response.json(pdvCache.data)
    let sharedRequest = pdvRequests.get(cacheKey)
    if (!sharedRequest) {
      sharedRequest = apiGet('/stats/ventas/por-pdv', { desde, hasta })
        .then(normalizarPdvs)
        .then((data) => {
          pdvCache = { key: cacheKey, data, expiresAt: Date.now() + 10 * 60_000 }
          return data
        })
        .finally(() => pdvRequests.delete(cacheKey))
      pdvRequests.set(cacheKey, sharedRequest)
    }
    response.json(await sharedRequest)
  } catch (error) {
    response.status(502).json({ message: error instanceof Error ? error.message : 'No se pudo consultar los PDV' })
  } 
})
//Inicia el servidor en el puerto especificado
app.listen(port, '0.0.0.0', () => {
  console.log(`Dashboard API ejecutándose en el puerto ${port}`)
})