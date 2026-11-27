import { useEffect, useMemo, useState } from 'react'
import writeXlsxFile from 'write-excel-file/browser'

type Kpis = { total: string; num_pedidos: number; ticket_promedio: string; num_pdvs_activos: number; num_clientes_distintos: number }
type RankingRow = { dimension: string; total: string; num_pedidos: number; ticket_promedio: string; participacion_pct: number; unidades?: number }
type SellerOption = { id: string; nombre: string; num_pedidos: number; ticket_promedio: string; total: string }
type Dashboard = {
  summary?: { kpis: Kpis }
  series?: { items: Array<{ periodo: string; total: string; num_pedidos: number }> }
  productRanking?: { items: RankingRow[] }
  sellerRanking?: { items: RankingRow[] }
  hourly?: { items: Array<{ hora: number; total: string; num_pedidos: number }> }
  orders?: { items: Array<{ id: number; fecha: string; sucursal?: string; vendedor_id?: number; vendedor_nombre?: string; total: string }> }
}

const pdvStorageKey = 'callcenter-dashboard-pdvs'

const money = (value: string | number | undefined) => new Intl.NumberFormat('es-AR', { style: 'currency', currency: 'ARS', maximumFractionDigits: 0 }).format(Number(value || 0))
const dateLabel = (date: string) => new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: 'short' }).format(new Date(`${date}T12:00:00`)).replace('.', '')
const orderDateLabel = (date: string) => new Intl.DateTimeFormat('es-AR', { day: '2-digit', month: '2-digit', year: 'numeric' }).format(new Date(date))

function App() {
  const today = new Date()
  const monthStart = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10)
  const [desde, setDesde] = useState(monthStart)
  const [hasta, setHasta] = useState(today.toISOString().slice(0, 10))
  const [selectedSeller, setSelectedSeller] = useState('')
  const [selectedPdv, setSelectedPdv] = useState('')
  const [pdvs, setPdvs] = useState<Array<{ nombre: string; num_pedidos_90d: number }>>([])
  const [pdvsLoaded, setPdvsLoaded] = useState(false)
  const [sellerOptions, setSellerOptions] = useState<SellerOption[]>([])
  const [sellerOptionsFilterKey, setSellerOptionsFilterKey] = useState('')
  const [sellerOptionsLoading, setSellerOptionsLoading] = useState(false)
  const [sellerOptionsError, setSellerOptionsError] = useState('')
  const [data, setData] = useState<Dashboard>({})
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const sellerFilterKey = JSON.stringify({ desde, hasta, pdv: selectedPdv })
  const pdvOptions = useMemo(
    () => pdvs.filter((pdv, index, items) => {
      const key = String(pdv.nombre || '').trim().toLowerCase()
      return key && items.findIndex((candidate) => String(candidate.nombre || '').trim().toLowerCase() === key) === index
    }),
    [pdvs],
  )
  const load = async () => {
    setLoading(true)
    setError('')
    setSellerOptionsLoading(sellerOptionsFilterKey !== sellerFilterKey)
    setSellerOptionsError('')
    try {
      const query = new URLSearchParams({
        desde,
        hasta,
        ...(selectedSeller ? { vendedor: selectedSeller } : {}),
        ...(selectedPdv ? { pdv: selectedPdv } : {}),
      })
      const dashboardPromise = fetch(`/api/dashboard?${query}`).then(async (result) => {
        if (!result.ok) throw new Error('No se pudieron actualizar los datos')
        return result.json() as Promise<Dashboard>
      })
      const sellersPromise = sellerOptionsFilterKey === sellerFilterKey
        ? Promise.resolve(sellerOptions)
        : fetch(`/api/vendedoras?${new URLSearchParams({ desde, hasta, ...(selectedPdv ? { pdv: selectedPdv } : {}) })}`)
          .then(async (result) => {
            if (!result.ok) throw new Error('No se pudieron cargar las vendedoras')
            return result.json() as Promise<SellerOption[]>
          })
      const pdvsPromise = pdvsLoaded
        ? Promise.resolve(pdvs)
        : fetch('/api/pdvs?desde=2026-05-01&hasta=2026-05-31')
          .then(async (result) => {
            if (!result.ok) throw new Error('No se pudieron cargar los puntos de venta')
            return result.json() as Promise<Array<{ nombre: string; num_pedidos_90d: number }>>
          })

      const [dashboard, sellers, availablePdvs] = await Promise.all([dashboardPromise, sellersPromise, pdvsPromise])
      setData(dashboard)
      setSellerOptions(sellers)
      setSellerOptionsFilterKey(sellerFilterKey)
      setSelectedSeller((current) => current && !sellers.some((seller) => seller.id === current) ? '' : current)
      setPdvs(availablePdvs)
      setPdvsLoaded(true)
      window.localStorage.setItem(pdvStorageKey, JSON.stringify(availablePdvs))
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : 'Ocurrió un error inesperado')
      setSellerOptionsError(reason instanceof Error ? reason.message : 'Error al cargar las vendedoras')
    } finally {
      setLoading(false)
      setSellerOptionsLoading(false)
    }
  }

  useEffect(() => {
    try {
      const cachedPdvs = window.localStorage.getItem(pdvStorageKey)
      if (cachedPdvs) {
        const parsedPdvs = JSON.parse(cachedPdvs)
        if (Array.isArray(parsedPdvs)) {
          setPdvs(parsedPdvs)
          setPdvsLoaded(true)
        }
      }
    } catch {
      window.localStorage.removeItem(pdvStorageKey)
    }
  }, [])

  const excludedProducts = new Set(['Bono de Regalo $50,000', 'Bono de Regalo $100,000'])
  const kpis = data.summary?.kpis
  const series = data.series?.items || []
  const product = (data.productRanking?.items || []).filter((item) => {
    const name = String(item.dimension || '').replace(/\s+/g, ' ').trim()
    if (!name) return false
    return ![...excludedProducts].some((excluded) => excluded.toLowerCase() === name.toLowerCase())
  }).slice(0, 10)
  const sellers = data.sellerRanking?.items || []
  const orders = [...(data.orders?.items || [])].sort((firstOrder, secondOrder) => new Date(firstOrder.fecha).getTime() - new Date(secondOrder.fecha).getTime())
  const maxSeries = Math.max(...series.map((item) => Number(item.total)), 1)
  const maxProduct = Math.max(...product.map((item) => Number(item.total)), 1)
  const peakHour = useMemo(() => (data.hourly?.items || []).reduce((peak, item) => Number(item.total) > Number(peak?.total || 0) ? item : peak, data.hourly?.items?.[0]), [data.hourly])

  //Exportar datos consultados a un libro Excel
  const exportToExcel = async () => {
    const sellersToExport = sellerOptions
      .filter((seller) => !selectedSeller || seller.id === selectedSeller)
      .sort((first, second) => Number(second.total) - Number(first.total))
    const buildSellerBreakdown = (getPeriod: (date: string) => string) => {
      const groups = new Map<string, { period: string; seller: string; orders: number; total: number }>()
      orders.forEach((order) => {
        const orderDate = order.fecha.slice(0, 10)
        const period = getPeriod(orderDate)
        const sellerId = String(order.vendedor_id || '')
        const seller = sellerOptions.find((option) => option.id === sellerId)?.nombre || order.vendedor_nombre || (sellerId ? `Vendedora ${sellerId}` : 'Vendedora sin asignar')
        const key = `${period}:${sellerId || seller}`
        const group = groups.get(key) || { period, seller, orders: 0, total: 0 }
        group.orders += 1
        group.total += Number(order.total || 0)
        groups.set(key, group)
      })

      return [...groups.values()]
        .sort((first, second) => first.period.localeCompare(second.period) || second.total - first.total)
        .map((group) => [group.period, group.seller, group.orders, group.orders ? group.total / group.orders : 0, group.total])
    }
    const sheets: Array<{ sheet: string; data: Array<Array<string | number>> }> = [
      {
        sheet: 'Resumen',
        data: [
          ['Indicador', 'Valor'],
          ['Desde', desde],
          ['Hasta', hasta],
          ['PDV', selectedPdv || 'Todos'],
          ['Vendedora', selectedSeller ? sellerOptions.find((seller) => seller.id === selectedSeller)?.nombre || selectedSeller : 'Todas'],
          ['Ventas totales', Number(kpis?.total || 0)],
          ['Pedidos', Number(kpis?.num_pedidos || 0)],
          ['Ticket promedio', Number(kpis?.ticket_promedio || 0)],
          ['PDV activos', Number(kpis?.num_pdvs_activos || 0)],
          ['Clientes únicos', Number(kpis?.num_clientes_distintos || 0)],
        ],
      },
    ]

    if (series.length) {
      sheets.push({ sheet: 'Evolución', data: [
        ['Fecha', 'Total', 'Pedidos'],
        ...series.map((item) => [item.periodo, Number(item.total || 0), Number(item.num_pedidos || 0)]),
      ] })
    }

    if (product.length) {
      sheets.push({ sheet: 'Productos', data: [
        ['Posición', 'Producto', 'Unidades', 'Total', 'Pedidos', 'Participación %'],
        ...product.map((item, index) => [index + 1, item.dimension, Number(item.unidades || 0), Number(item.total || 0), Number(item.num_pedidos || 0), Number(item.participacion_pct || 0)]),
      ] })
    }

    if (sellersToExport.length) {
      sheets.push({ sheet: 'Vendedoras', data: [
        ['Posición', 'Vendedora', 'Pedidos', 'Ticket promedio', 'Total vendido'],
        ...sellersToExport.map((seller, index) => [index + 1, seller.nombre, Number(seller.num_pedidos || 0), Number(seller.ticket_promedio || 0), Number(seller.total || 0)]),
      ] })
    }

    if (orders.length) {
      sheets.push({ sheet: 'Pedidos', data: [
        ['Pedido', 'Fecha', 'Sucursal', 'Vendedor', 'Total'],
        ...orders.map((order) => [order.id, order.fecha, order.sucursal || '', order.vendedor_nombre || '', Number(order.total || 0)]),
      ] })
      sheets.push({ sheet: 'Vendedoras por día', data: [
        ['Día', 'Vendedora', 'Pedidos', 'Ticket promedio', 'Total vendido'],
        ...buildSellerBreakdown((date) => date),
      ] })
      sheets.push({ sheet: 'Vendedoras por mes', data: [
        ['Mes', 'Vendedora', 'Pedidos', 'Ticket promedio', 'Total vendido'],
        ...buildSellerBreakdown((date) => date.slice(0, 7)),
      ] })
    }

    const blob = await writeXlsxFile(sheets).toBlob()
    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = `dashboard-ventas-${desde}-al-${hasta}.xlsx`
    document.body.appendChild(link)
    link.click()
    document.body.removeChild(link)
    URL.revokeObjectURL(url)
  }
  //Cabecera de la página
  return <div className="app-shell">
    <header className="topbar">
      <div className="brand"><span className="brand-mark">CC</span><span>CALLCENTER</span></div>
    </header>
    <main className="page">

      {/* Panel de filtros */}
      <section className="intro">
        <div className="intro-title"><h1>Dashboard ventas Callcenter</h1></div>
        <div className="filters">
          <label>Desde<input type="date" value={desde} disabled={loading} onChange={(event) => { setDesde(event.target.value); setSelectedSeller(''); setSellerOptions([]); setSellerOptionsFilterKey('') }} /></label>
          <label>Hasta<input type="date" value={hasta} disabled={loading} onChange={(event) => { setHasta(event.target.value); setSelectedSeller(''); setSellerOptions([]); setSellerOptionsFilterKey('') }} /></label>
          <label>Vendedora<select value={selectedSeller} disabled={loading || sellerOptionsLoading || !sellerOptions.length} onChange={(event) => setSelectedSeller(event.target.value)}><option value="">Todas las vendedoras</option>{sellerOptionsLoading && <option disabled value="__loading">Cargando vendedoras...</option>}{sellerOptionsError && <option disabled value="__error">{sellerOptionsError}</option>}{!sellerOptionsLoading && !sellerOptionsError && !sellerOptions.length && <option disabled value="__empty"></option>}{sellerOptions.map((seller) => <option key={seller.id} value={seller.id}>{seller.nombre}</option>)}</select></label>
          <label>PDV<select value={selectedPdv} disabled={loading} onChange={(event) => { setSelectedPdv(event.target.value); setSelectedSeller(''); setSellerOptions([]); setSellerOptionsFilterKey('') }}><option value="">Todos los puntos de venta</option>{pdvOptions.map((pdv) => <option key={pdv.nombre} value={pdv.nombre}>{pdv.nombre}</option>)}</select></label>
          <button className="apply-button" onClick={load} disabled={loading}>{loading ? 'Cargando...' : 'Consultar'}</button>
          <button className="export-button" onClick={exportToExcel} disabled={loading || !series.length}>Exportar</button>
        </div>

      {/* Panel de KPIs */}
      </section>
      {error && <div className="error-banner">{error}. Revisa que el servidor esté ejecutándose y vuelve a intentar.</div>}
      <section className="kpi-grid">
        <Kpi label="Ventas totales" value={money(kpis?.total)} note="Monto total registrado" accent="" />
        <Kpi label="Pedidos" value={kpis?.num_pedidos?.toLocaleString('es-AR') || '—'} note="Órdenes confirmadas" accent="" />
        <Kpi label="Ticket promedio" value={money(kpis?.ticket_promedio)} note="Valor promedio por pedido" accent="" />
        <Kpi label="PDV activos" value={kpis?.num_pdvs_activos?.toString() || '—'} note="Con actividad en el período" accent="" />
      </section>

      {/* Panel de ventas general */}
      <section className="dashboard-grid">
        <article className="panel trend-panel"><PanelHeading title="Evolución de ventas" meta="Monto por día" /><div className="chart"><div className="y-axis"><span>{money(maxSeries)}</span><span>{money(maxSeries / 2)}</span><span>$ 0</span></div><div className="bars">{series.length ? series.map((item) => <div className="bar-wrap" key={item.periodo}><span className="bar-orders">{item.num_pedidos}</span><div className="bar" title={`${dateLabel(item.periodo)}: ${money(item.total)} · ${item.num_pedidos} pedidos`} style={{ height: `${Math.max((Number(item.total) / maxSeries) * 100, 5)}%` }} /><span className="bar-date">{dateLabel(item.periodo)}</span></div>) : <EmptyState />}</div></div></article>
        <article className="panel highlight-panel"><PanelHeading title="Artículo más vendido" meta="Valor total vendido" /><div className="highlight-content"><span className="rank-badge">#1</span><div><h2>{product[0]?.dimension || 'Sin datos'}</h2><p>{product[0] ? `${product[0].unidades || 0} unidades vendidas` : 'Consulta un período para los datos'}</p></div><strong title="Valor total vendido">{product[0] ? money(product[0].total) : '—'}</strong></div><div className="mini-stats"><span><b>{product[0]?.num_pedidos || 0}</b> Pedidos</span><span><b>{product[0]?.participacion_pct?.toFixed(1) || 0}%</b> Participación</span></div></article>
      </section>

      {/* Ranking de productos y vendedoras destacadas */}
      <section className="dashboard-grid lower-grid">
        <article className="panel ranking-panel"><PanelHeading title="Listado de productos" meta="Total vendido" />{product.length ? product.map((item, index) => <div className="ranking-row" key={`${item.dimension}-${index}`}><span className="rank-number">{String(index + 1).padStart(2, '0')}</span><div className="row-main"><div className="row-label"><strong>{item.dimension}</strong><span>{item.unidades || 0} un.</span></div><div className="progress"><i style={{ width: `${(Number(item.total) / maxProduct) * 100}%` }} /></div></div><b className="row-total" title="Valor total vendido">{money(item.total)}</b></div>) : <EmptyState />}</article>
        <article className="panel seller-panel"><PanelHeading title="Vendedoras destacadas" meta="Total vendido" />{sellers.slice(0, 4).map((seller, index) => <div className="seller-row" key={`${seller.dimension}-${index}`}><span className={`avatar avatar-${index}`}>{seller.dimension.split(' ').map((part) => part[0]).join('').slice(0, 2)}</span><div className="seller-info"><strong>{seller.dimension}</strong><span>{seller.num_pedidos} pedidos</span></div><span className="seller-average"><small>Ticket promedio</small><strong>{money(seller.ticket_promedio)}</strong></span><b title="Valor total vendido">{money(seller.total)}</b></div>)}{!sellers.length && <EmptyState />}</article>
      </section>

      {/* Panel de pedidos consultados */} 
      <section className="panel activity-panel"><PanelHeading title="Listado de pedidos" meta="Últimos pedidos" /><div className="activity-layout"><div className="orders">{orders.length ? orders.map((order) => <div className="order-row" key={order.id}><span className="order-icon"></span><div><strong>Pedido #{order.id}</strong><span>{orderDateLabel(order.fecha)} · {order.sucursal || 'PDV sin especificar'} · {order.vendedor_nombre || 'Vendedor sin asignar'}</span></div><b>{money(order.total)}</b><time>{new Intl.DateTimeFormat('es-AR', { hour: '2-digit', minute: '2-digit' }).format(new Date(order.fecha))}</time></div>) : <EmptyState />}</div><div className="peak-card"><span className="eyebrow">HORA PICO</span><strong>{peakHour ? `${String(peakHour.hora).padStart(2, '0')}:00` : '—'}</strong><p>{peakHour ? `${peakHour.num_pedidos} pedidos concentrados` : 'Sin actividad disponible'}</p></div></div></section>
    </main> 
  </div>
}

//Generardor de KPIs, paneles y estados vacíos
function Kpi({ label, value, accent }: { label: string; value: string; note: string; accent: string }) { return <article className={`kpi kpi-${accent}`}><div className="kpi-top"><span>{label}</span></div><strong>{value}</strong></article> }
function PanelHeading({ title, meta }: { title: string; meta: string }) { return <div className="panel-heading"><h3>{title}</h3><span>{meta}</span></div> }
function EmptyState() { return <div className="empty-state">No hay datos para este período.</div> }
export default App