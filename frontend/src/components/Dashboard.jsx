import { useState, useEffect, useRef } from 'react';
import { AreaChart, Area, BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { getMetrics, getLogs, connectLiveEvents } from '../lib/api.js';

const HOURS_OPTIONS = [1, 6, 24, 72, 168];

function StatCard({ label, value, sub, color = 'var(--text)', accent }) {
  return (
    <div style={{
      background: 'var(--bg2)', border: '1px solid var(--border)',
      borderRadius: 'var(--radius2)', padding: '16px 18px',
      minWidth: 0,
    }}>
      <div style={{ fontSize: 11, color: 'var(--text3)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '.07em', marginBottom: 6 }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 700, color, fontFamily: 'var(--mono)', letterSpacing: '-1px', lineHeight: 1 }}>{value ?? '—'}</div>
      {sub && <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>{sub}</div>}
    </div>
  );
}

function StatusBadge({ status }) {
  const map = {
    success: { bg: 'var(--accent-dim)', color: 'var(--accent)', border: 'var(--accent-glow)' },
    error: { bg: 'var(--red-dim)', color: 'var(--red)', border: 'rgba(248,113,113,.2)' },
    cancelled: { bg: 'var(--yellow-dim)', color: 'var(--yellow)', border: 'rgba(251,191,36,.2)' },
    timeout: { bg: 'var(--blue-dim)', color: 'var(--blue)', border: 'rgba(96,165,250,.2)' },
  };
  const c = map[status] || map.error;
  return (
    <span style={{
      fontSize: 10, fontWeight: 600, padding: '2px 7px',
      borderRadius: 4, border: `1px solid ${c.border}`,
      background: c.bg, color: c.color, letterSpacing: '.04em',
    }}>{status?.toUpperCase()}</span>
  );
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div style={{
      background: 'var(--bg3)', border: '1px solid var(--border2)',
      borderRadius: 6, padding: '8px 12px', fontSize: 12,
    }}>
      <div style={{ color: 'var(--text2)', marginBottom: 4 }}>{label}</div>
      {payload.map((p, i) => (
        <div key={i} style={{ color: p.color || 'var(--text)', display: 'flex', gap: 8, justifyContent: 'space-between' }}>
          <span>{p.name}</span><strong>{typeof p.value === 'number' ? p.value.toLocaleString() : p.value}</strong>
        </div>
      ))}
    </div>
  );
};

function formatHour(ts) {
  const d = new Date(ts);
  return d.getHours() + ':00';
}

export default function Dashboard() {
  const [hours, setHours] = useState(24);
  const [metrics, setMetrics] = useState(null);
  const [logs, setLogs] = useState([]);
  const [loading, setLoading] = useState(true);
  const [liveEvents, setLiveEvents] = useState([]);
  const esRef = useRef(null);

  async function load() {
    setLoading(true);
    try {
      const [m, l] = await Promise.all([getMetrics(hours), getLogs({ limit: 20 })]);
      setMetrics(m);
      setLogs(l.logs || []);
    } catch {}
    setLoading(false);
  }

  useEffect(() => { load(); }, [hours]);

  // Auto-refresh every 15s
  useEffect(() => {
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [hours]);

  // Live events SSE
  useEffect(() => {
    try {
      esRef.current = connectLiveEvents((evt) => {
        setLiveEvents(prev => [{ ...evt, _id: Math.random() }, ...prev].slice(0, 8));
        // Refresh metrics when new inference logged
        if (evt.eventType === 'inference_logged') load();
      });
    } catch {}
    return () => esRef.current?.close();
  }, []);

  const ov = metrics?.overview || {};

  const chartData = (metrics?.by_hour || []).map(r => ({
    hour: formatHour(r.hour),
    requests: parseInt(r.requests) || 0,
    errors: parseInt(r.errors) || 0,
    latency: parseInt(r.avg_latency_ms) || 0,
    tokens: parseInt(r.tokens) || 0,
  }));

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: '20px 24px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div>
          <h1 style={{ fontSize: 20, fontWeight: 700, letterSpacing: '-0.4px' }}>Inference Dashboard</h1>
          <p style={{ color: 'var(--text3)', fontSize: 12, marginTop: 2 }}>Real-time LLM metrics · PII redacted</p>
        </div>
        <div style={{ display: 'flex', gap: 4 }}>
          {HOURS_OPTIONS.map(h => (
            <button key={h} onClick={() => setHours(h)} style={{
              padding: '5px 10px', borderRadius: 5, fontSize: 12, fontWeight: 500,
              background: hours === h ? 'var(--accent-dim)' : 'var(--bg3)',
              border: `1px solid ${hours === h ? 'var(--accent-glow)' : 'var(--border)'}`,
              color: hours === h ? 'var(--accent)' : 'var(--text2)',
              transition: 'all .15s',
            }}>
              {h < 24 ? `${h}h` : h === 24 ? '24h' : h === 72 ? '3d' : '7d'}
            </button>
          ))}
          <button onClick={load} style={{
            padding: '5px 10px', borderRadius: 5, fontSize: 12,
            background: 'var(--bg3)', border: '1px solid var(--border)', color: 'var(--text2)',
            marginLeft: 4,
          }}>↻</button>
        </div>
      </div>

      {/* Stat Cards */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 12 }}>
        <StatCard label="Total Requests" value={parseInt(ov.total || 0).toLocaleString()} sub={`${hours}h window`} />
        <StatCard label="Error Rate" value={`${ov.error_rate_pct ?? 0}%`}
          color={parseFloat(ov.error_rate_pct) > 5 ? 'var(--red)' : 'var(--accent)'}
          sub={`${ov.errors ?? 0} errors`} />
        <StatCard label="Avg Latency" value={ov.avg_latency_ms ? `${ov.avg_latency_ms}ms` : '—'}
          sub={`p95: ${ov.p95_latency_ms ?? '—'}ms`} color="var(--blue)" />
        <StatCard label="Total Cost" value={`$${parseFloat(ov.total_cost_usd ?? 0).toFixed(4)}`}
          sub={`${parseInt(ov.total_tokens || 0).toLocaleString()} tokens`} color="var(--yellow)" />
      </div>

      {/* Charts row */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* Throughput + Errors */}
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 'var(--radius2)', padding: '16px 16px 8px' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)', marginBottom: 14 }}>Requests & Errors</div>
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart data={chartData} margin={{ top: 0, right: 0, bottom: 0, left: -20 }}>
              <defs>
                <linearGradient id="gReq" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#4ade80" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#4ade80" stopOpacity={0} />
                </linearGradient>
                <linearGradient id="gErr" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="5%" stopColor="#f87171" stopOpacity={0.3} />
                  <stop offset="95%" stopColor="#f87171" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="hour" tick={{ fill: 'var(--text3)', fontSize: 10 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
              <YAxis tick={{ fill: 'var(--text3)', fontSize: 10 }} tickLine={false} axisLine={false} />
              <Tooltip content={<CustomTooltip />} />
              <Area type="monotone" dataKey="requests" name="Requests" stroke="#4ade80" fill="url(#gReq)" strokeWidth={2} dot={false} />
              <Area type="monotone" dataKey="errors" name="Errors" stroke="#f87171" fill="url(#gErr)" strokeWidth={2} dot={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>

        {/* Latency */}
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 'var(--radius2)', padding: '16px 16px 8px' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)', marginBottom: 14 }}>Avg Latency (ms)</div>
          <ResponsiveContainer width="100%" height={160}>
            <BarChart data={chartData} margin={{ top: 0, right: 0, bottom: 0, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="var(--border)" />
              <XAxis dataKey="hour" tick={{ fill: 'var(--text3)', fontSize: 10 }} tickLine={false} axisLine={false} interval="preserveStartEnd" />
              <YAxis tick={{ fill: 'var(--text3)', fontSize: 10 }} tickLine={false} axisLine={false} />
              <Tooltip content={<CustomTooltip />} />
              <Bar dataKey="latency" name="Latency (ms)" fill="#60a5fa" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Model breakdown + Live events */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        {/* Model breakdown */}
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 'var(--radius2)', padding: 16, overflow: 'hidden' }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)', marginBottom: 12 }}>By Model</div>
          {(metrics?.by_model || []).length === 0 && (
            <div style={{ color: 'var(--text3)', fontSize: 12 }}>No data yet</div>
          )}
          {(metrics?.by_model || []).map((m, i) => (
            <div key={i} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '8px 0', borderBottom: '1px solid var(--border)',
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 12, fontWeight: 500, color: 'var(--text)' }}>{m.model}</div>
                <div style={{ fontSize: 11, color: 'var(--text3)' }}>{m.provider}</div>
              </div>
              <div style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12 }}>
                <div style={{ color: 'var(--text)' }}>{parseInt(m.requests).toLocaleString()} req</div>
                <div style={{ color: 'var(--text3)' }}>{m.avg_latency_ms}ms avg</div>
              </div>
              <div style={{ textAlign: 'right', fontFamily: 'var(--mono)', fontSize: 12, color: 'var(--yellow)', minWidth: 56 }}>
                ${parseFloat(m.cost_usd || 0).toFixed(4)}
              </div>
            </div>
          ))}
        </div>

        {/* Live events feed */}
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 'var(--radius2)', padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
            <div style={{ width: 7, height: 7, borderRadius: '50%', background: 'var(--accent)', animation: 'pulse 2s ease infinite' }} />
            <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)' }}>Live Events</div>
          </div>
          {liveEvents.length === 0 && (
            <div style={{ color: 'var(--text3)', fontSize: 12 }}>Waiting for events…</div>
          )}
          {liveEvents.map((evt, i) => (
            <div key={evt._id} style={{
              padding: '7px 0',
              borderBottom: i < liveEvents.length - 1 ? '1px solid var(--border)' : 'none',
              animation: 'fadeIn .2s ease',
            }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--accent)', fontFamily: 'var(--mono)' }}>{evt.eventType}</span>
                <span style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'var(--mono)' }}>
                  {new Date(evt.ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                </span>
              </div>
              {evt.payload && (
                <div style={{ fontSize: 11, color: 'var(--text3)', fontFamily: 'var(--mono)', marginTop: 2 }}>
                  {evt.payload.model && `${evt.payload.model} · `}
                  {evt.payload.latency_ms && `${evt.payload.latency_ms}ms · `}
                  {evt.payload.status && <StatusBadge status={evt.payload.status} />}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      {/* Error breakdown */}
      {(metrics?.error_breakdown || []).length > 0 && (
        <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 'var(--radius2)', padding: 16 }}>
          <div style={{ fontSize: 12, fontWeight: 600, color: 'var(--text2)', marginBottom: 12 }}>Error Breakdown</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {(metrics.error_breakdown || []).map((e, i) => (
              <div key={i} style={{
                padding: '6px 14px', background: 'var(--red-dim)',
                border: '1px solid rgba(248,113,113,.2)',
                borderRadius: 6, fontSize: 12, fontFamily: 'var(--mono)',
              }}>
                <span style={{ color: 'var(--red)' }}>{e.error_code || 'unknown'}</span>
                <span style={{ color: 'var(--text3)', marginLeft: 8 }}>{e.count}×</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Recent Logs Table */}
      <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 'var(--radius2)', overflow: 'hidden' }}>
        <div style={{ padding: '14px 16px', borderBottom: '1px solid var(--border)', fontSize: 12, fontWeight: 600, color: 'var(--text2)' }}>
          Recent Inference Logs
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--bg3)' }}>
                {['Time', 'Provider/Model', 'Status', 'Latency', 'Tokens', 'Cost', 'Input Preview'].map(h => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: 'left', color: 'var(--text3)', fontWeight: 600, fontSize: 11, whiteSpace: 'nowrap', textTransform: 'uppercase', letterSpacing: '.06em' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {logs.length === 0 && (
                <tr><td colSpan={7} style={{ padding: '16px', color: 'var(--text3)', textAlign: 'center' }}>No logs yet</td></tr>
              )}
              {logs.map((log, i) => (
                <tr key={log.id} style={{ borderTop: '1px solid var(--border)', transition: 'background .1s' }}
                  onMouseEnter={e => e.currentTarget.style.background = 'var(--bg3)'}
                  onMouseLeave={e => e.currentTarget.style.background = 'transparent'}
                >
                  <td style={{ padding: '8px 12px', color: 'var(--text3)', fontFamily: 'var(--mono)', whiteSpace: 'nowrap' }}>
                    {new Date(log.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                  </td>
                  <td style={{ padding: '8px 12px', fontFamily: 'var(--mono)' }}>
                    <div style={{ color: 'var(--text)', fontSize: 11 }}>{log.model}</div>
                    <div style={{ color: 'var(--text3)', fontSize: 10 }}>{log.provider}</div>
                  </td>
                  <td style={{ padding: '8px 12px' }}><StatusBadge status={log.status} /></td>
                  <td style={{ padding: '8px 12px', fontFamily: 'var(--mono)', color: 'var(--blue)' }}>{log.latency_ms != null ? `${log.latency_ms}ms` : '—'}</td>
                  <td style={{ padding: '8px 12px', fontFamily: 'var(--mono)', color: 'var(--text2)' }}>
                    {log.total_tokens != null ? log.total_tokens.toLocaleString() : '—'}
                  </td>
                  <td style={{ padding: '8px 12px', fontFamily: 'var(--mono)', color: 'var(--yellow)' }}>
                    {log.estimated_cost_usd != null ? `$${parseFloat(log.estimated_cost_usd).toFixed(5)}` : '—'}
                  </td>
                  <td style={{ padding: '8px 12px', color: 'var(--text3)', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {log.input_preview || '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
