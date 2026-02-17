import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile, writeTextFile } from "@tauri-apps/plugin-fs";
import type { FlowRecord, ProxyEvent, ProxyCommand, ProxyStatus } from "./ipc/schema";
import "./App.css";
import appIcon from "../packetlens-icon-preview.svg";

const IPC_PORT = 8787;
const MAX_ROWS = 5000;
type ColumnKey = "time" | "method" | "host" | "path" | "status" | "size" | "duration";
type BrowserTarget = "edge" | "chrome" | "firefox" | "brave";

const formatDuration = (ms: number) => `${ms} ms`;

const getHeader = (headers: FlowRecord["response_headers"], name: string) => {
  if (!headers) {
    return "";
  }
  const match = headers.find((header) => header.name.toLowerCase() === name.toLowerCase());
  return match?.value ?? "";
};

const getCategory = (record: FlowRecord) => {
  const contentType = getHeader(record.response_headers, "content-type").toLowerCase();
  const path = record.path.toLowerCase();
  if (record.scheme.startsWith("ws")) {
    return "WebSocket";
  }
  if (record.scheme === "http") {
    return "HTTP";
  }
  if (record.scheme === "https") {
    return "HTTPS";
  }
  if (contentType.includes("json") || path.endsWith(".json")) {
    return "JSON";
  }
  if (contentType.includes("xml") || path.endsWith(".xml")) {
    return "XML";
  }
  if (contentType.includes("javascript") || path.endsWith(".js")) {
    return "JS";
  }
  if (contentType.includes("css") || path.endsWith(".css")) {
    return "CSS";
  }
  return "Other";
};

const formatHeaders = (headers: FlowRecord["response_headers"] | FlowRecord["request_headers"]) => {
  if (!headers || headers.length === 0) {
    return "No headers";
  }
  return headers.map((header) => `${header.name}: ${header.value}`).join("\n");
};

const tryParseJson = (text: string) => {
  if (!text || !text.trim()) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

const prettyJson = (text: string) => {
  const parsed = tryParseJson(text);
  if (!parsed) {
    return "";
  }
  return JSON.stringify(parsed, null, 2);
};

const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const matchesColumnFilter = (value: string, filterText: string) => {
  const term = filterText.trim();
  if (!term) {
    return true;
  }
  if (term.includes("%")) {
    const regexPattern = `^${escapeRegex(term).replace(/%/g, ".*")}$`;
    try {
      return new RegExp(regexPattern, "i").test(value);
    } catch {
      return value.toLowerCase().includes(term.toLowerCase().replace(/%/g, ""));
    }
  }
  return value.toLowerCase().includes(term.toLowerCase());
};

const renderJsonTreeNode = (name: string, value: unknown, keyPath: string): ReactElement => {
  if (Array.isArray(value)) {
    return (
      <li key={keyPath}>
        <span className="tree-key">{name}</span>
        <ul className="json-tree">
          {value.map((item, index) => (
            renderJsonTreeNode(String(index), item, `${keyPath}.${index}`)
          ))}
        </ul>
      </li>
    );
  }
  if (value !== null && typeof value === "object") {
    return (
      <li key={keyPath}>
        <span className="tree-key">{name}</span>
        <ul className="json-tree">
          {Object.entries(value).map(([key, nested]) => (
            renderJsonTreeNode(key, nested, `${keyPath}.${key}`)
          ))}
        </ul>
      </li>
    );
  }
  return (
    <li key={keyPath}>
      <span>
        <span className="tree-key">{name}: </span>
        <span className="tree-value">{String(value)}</span>
      </span>
    </li>
  );
};

const renderJsonTreeRoot = (value: unknown): ReactElement => {
  if (Array.isArray(value)) {
    return (
      <ul className="json-tree root-tree">
        {value.map((item, index) => renderJsonTreeNode(String(index), item, `root.${index}`))}
      </ul>
    );
  }
  if (value !== null && typeof value === "object") {
    return (
      <ul className="json-tree root-tree">
        {Object.entries(value).map(([key, nested]) => renderJsonTreeNode(key, nested, `root.${key}`))}
      </ul>
    );
  }
  return (
    <pre>
      <span className="tree-value">{String(value)}</span>
    </pre>
  );
};

function App() {
  const [records, setRecords] = useState<FlowRecord[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [detailsTab, setDetailsTab] = useState<"request" | "response">("request");
  const [subTab, setSubTab] = useState<"raw" | "headers" | "json" | "tree">("raw");
  const [activeFilter, setActiveFilter] = useState("All");
  const [search, setSearch] = useState("");
  const [hostFilter, setHostFilter] = useState("");
  const [sortCol, setSortCol] = useState<ColumnKey>("time");
  const [sortAsc, setSortAsc] = useState(true);
  const [columnFilters, setColumnFilters] = useState<Record<ColumnKey, string>>({
    time: "",
    method: "",
    host: "",
    path: "",
    status: "",
    size: "",
    duration: "",
  });
  const [columnWidths, setColumnWidths] = useState<Record<ColumnKey, number>>({
    time: 130,
    method: 100,
    host: 220,
    path: 360,
    status: 90,
    size: 110,
    duration: 110,
  });
  const [statusText, setStatusText] = useState("Stopped");
  const [proxyState, setProxyState] = useState<ProxyStatus>("stopped");
  const [activeProxyPort, setActiveProxyPort] = useState<number | null>(null);
  const [port, setPort] = useState("8192");
  const [paused, setPaused] = useState(false);
  const [autoScroll, setAutoScroll] = useState(true);
  const [browserTarget, setBrowserTarget] = useState<BrowserTarget>("edge");
  const [autoOpenBrowserPending, setAutoOpenBrowserPending] = useState(false);
  const [tablePanelHeight, setTablePanelHeight] = useState<number | null>(null);
  const [showAbout, setShowAbout] = useState(false);
  const contentSplitRef = useRef<HTMLDivElement | null>(null);
  const tableScrollRef = useRef<HTMLDivElement | null>(null);
  const resizeStateRef = useRef<{ col: ColumnKey; startX: number; startWidth: number } | null>(null);
  const panelResizeStateRef = useRef<{ startY: number; startHeight: number } | null>(null);
  const proxyStateRef = useRef<ProxyStatus>("stopped");
  const autoOpenPendingRef = useRef(false);
  const browserTargetRef = useRef<BrowserTarget>("edge");
  const activeProxyPortRef = useRef<number | null>(null);
  const portRef = useRef("8192");

  const selected = useMemo(
    () => records.find((record) => record.id === selectedId) ?? records[0],
    [records, selectedId],
  );
  const isCaptureOn = proxyState === "running";

  useEffect(() => {
    proxyStateRef.current = proxyState;
  }, [proxyState]);

  useEffect(() => {
    autoOpenPendingRef.current = autoOpenBrowserPending;
  }, [autoOpenBrowserPending]);

  useEffect(() => {
    browserTargetRef.current = browserTarget;
  }, [browserTarget]);

  useEffect(() => {
    activeProxyPortRef.current = activeProxyPort;
    portRef.current = port;
  }, [activeProxyPort, port]);

  const scrollToLatest = () => {
    const scrollEl = tableScrollRef.current;
    if (!scrollEl) {
      return;
    }
    scrollEl.scrollTop = scrollEl.scrollHeight;
  };

  useEffect(() => {
    let unlisten: UnlistenFn | null = null;
    listen<ProxyEvent>("proxy-event", (event) => {
      const payload = event.payload;
      if (payload.type === "flow") {
        setRecords((prev) => {
          const next = [...prev, payload.record];
          return next.slice(-MAX_ROWS);
        });
        setSelectedId((prev) => prev || payload.record.id);
      } else if (payload.type === "status") {
        // Ignore transient "Ready" status that can arrive while startup is in progress.
        const isTransientReady =
          payload.status === "stopped" &&
          (payload.message ?? "").toLowerCase() === "ready" &&
          (proxyStateRef.current === "starting" || autoOpenPendingRef.current);
        if (isTransientReady) {
          return;
        }
        setStatusText(payload.message ?? payload.status);
        setProxyState(payload.status);
        setPaused(payload.status === "paused");
        if (payload.port) {
          setActiveProxyPort(payload.port);
          setPort(String(payload.port));
        }
        if (autoOpenPendingRef.current && payload.status === "running") {
          autoOpenPendingRef.current = false;
          setAutoOpenBrowserPending(false);
          window.setTimeout(() => {
            void invoke("open_browser", {
              port: activeProxyPortRef.current ?? (Number(portRef.current) || 8192),
              browser: browserTargetRef.current,
            }).catch((error) => window.alert(String(error)));
          }, 120);
        }
        if (payload.status === "stopped") {
          autoOpenPendingRef.current = false;
          setAutoOpenBrowserPending(false);
        }
      } else if (payload.type === "error") {
        setStatusText(payload.message);
        setProxyState("stopped");
        autoOpenPendingRef.current = false;
        setAutoOpenBrowserPending(false);
        window.alert(payload.message);
      }
    }).then((fn) => {
      unlisten = fn;
    });

    return () => {
      if (unlisten) {
        unlisten();
      }
    };
  }, []);

  useEffect(() => {
    const scrollEl = tableScrollRef.current;
    if (!scrollEl) {
      return;
    }
    if (autoScroll) {
      scrollToLatest();
    }
  }, [records, autoScroll]);

  useEffect(() => {
    const handleMouseMove = (event: MouseEvent) => {
      if (resizeStateRef.current) {
        const { col, startX, startWidth } = resizeStateRef.current;
        const width = Math.max(80, startWidth + (event.clientX - startX));
        setColumnWidths((prev) => ({ ...prev, [col]: width }));
      }
      if (panelResizeStateRef.current) {
        const rootHeight = contentSplitRef.current?.clientHeight ?? 0;
        const { startY, startHeight } = panelResizeStateRef.current;
        const nextHeight = startHeight + (event.clientY - startY);
        const minHeight = 220;
        const maxHeight = rootHeight > 0 ? Math.max(minHeight, rootHeight - 220) : 1000;
        setTablePanelHeight(Math.max(minHeight, Math.min(maxHeight, nextHeight)));
      }
    };
    const handleMouseUp = () => {
      resizeStateRef.current = null;
      panelResizeStateRef.current = null;
    };
    window.addEventListener("mousemove", handleMouseMove);
    window.addEventListener("mouseup", handleMouseUp);
    return () => {
      window.removeEventListener("mousemove", handleMouseMove);
      window.removeEventListener("mouseup", handleMouseUp);
    };
  }, []);

  useEffect(() => {
    if (tablePanelHeight !== null) {
      return;
    }
    const root = contentSplitRef.current;
    if (!root) {
      return;
    }
    setTablePanelHeight(Math.max(220, Math.round(root.clientHeight * 0.45)));
  }, [tablePanelHeight]);

  const getColumnText = (record: FlowRecord, col: ColumnKey) => {
    switch (col) {
      case "time":
        return new Date(record.started * 1000).toLocaleTimeString();
      case "method":
        return record.method;
      case "host":
        return record.host;
      case "path":
        return record.path;
      case "status":
        return String(record.status_code || "--");
      case "size":
        return String(record.response_body_size);
      case "duration":
        return formatDuration(record.duration_ms);
      default:
        return "";
    }
  };

  const filteredRecords = useMemo(() => {
    const searchLower = search.trim().toLowerCase();
    const hostLower = hostFilter.trim().toLowerCase();
    return records.filter((record) => {
      const category = getCategory(record);
      if (activeFilter !== "All" && category !== activeFilter) {
        return false;
      }
      if (hostLower && !record.host.toLowerCase().includes(hostLower)) {
        return false;
      }
      if (searchLower) {
        const haystack = `${record.url} ${record.method} ${record.host} ${record.path}`.toLowerCase();
        if (!haystack.includes(searchLower)) {
          return false;
        }
      }
      const allColumnFiltersMatch = (Object.entries(columnFilters) as Array<[ColumnKey, string]>).every(([col, value]) =>
        matchesColumnFilter(getColumnText(record, col), value),
      );
      if (!allColumnFiltersMatch) {
        return false;
      }
      return true;
    });
  }, [records, activeFilter, hostFilter, search, columnFilters]);

  const sortedRecords = useMemo(() => {
    const copy = [...filteredRecords];
    const factor = sortAsc ? 1 : -1;
    copy.sort((a, b) => {
      switch (sortCol) {
        case "time":
          return factor * (a.started - b.started);
        case "method":
          return factor * a.method.localeCompare(b.method);
        case "host":
          return factor * a.host.localeCompare(b.host);
        case "path":
          return factor * a.path.localeCompare(b.path);
        case "status":
          return factor * ((a.status_code || 0) - (b.status_code || 0));
        case "size":
          return factor * (a.response_body_size - b.response_body_size);
        case "duration":
          return factor * (a.duration_ms - b.duration_ms);
        default:
          return 0;
      }
    });
    return copy;
  }, [filteredRecords, sortCol, sortAsc]);

  const toggleSort = (col: ColumnKey) => {
    if (sortCol === col) {
      setSortAsc(!sortAsc);
    } else {
      setSortCol(col);
      setSortAsc(true);
    }
  };

  const renderHeader = (col: ColumnKey, label: string) => (
    <div className="th-content">
      <span className="sortable">
        {label}
        {sortCol === col ? (sortAsc ? " ▲" : " ▼") : ""}
      </span>
      <span
        className="col-resizer"
        onClick={(event) => event.stopPropagation()}
        onMouseDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          resizeStateRef.current = { col, startX: event.clientX, startWidth: columnWidths[col] };
        }}
      />
    </div>
  );

  const sendCommand = async (command: ProxyCommand) => {
    await invoke("send_proxy_command", { ipcPort: IPC_PORT, command });
  };

  const requestProxyStartAndAutoOpenBrowser = async (requestedPort: number) => {
    setProxyState("starting");
    setStatusText(`Starting on ${requestedPort}...`);
    setAutoOpenBrowserPending(true);
    await sendCommand({ type: "start", port: requestedPort });
  };

  const startCapture = async () => {
    if (proxyState === "starting" || proxyState === "running") {
      return;
    }
    try {
      await invoke("start_sidecar", { ipcPort: IPC_PORT });
      await invoke("start_sidecar_listener", { ipcPort: IPC_PORT });
      await requestProxyStartAndAutoOpenBrowser(Number(port) || 8192);
    } catch (error) {
      setProxyState("stopped");
      setStatusText("Failed to start");
      setAutoOpenBrowserPending(false);
      window.alert(String(error));
    }
  };

  const stopCapture = async () => {
    if (proxyState === "stopped") {
      return;
    }
    await sendCommand({ type: "stop" });
    setAutoOpenBrowserPending(false);
    setProxyState("stopped");
    setStatusText("Stopped");
  };

  const togglePause = async () => {
    if (proxyState !== "running" && proxyState !== "paused") {
      return;
    }
    if (paused) {
      await sendCommand({ type: "resume" });
    } else {
      await sendCommand({ type: "pause" });
    }
  };

  const handleSaveJson = async () => {
    const target = await save({ defaultPath: "packetlens.json", filters: [{ name: "JSON", extensions: ["json"] }] });
    if (!target) {
      return;
    }
    await writeTextFile(target, JSON.stringify(records, null, 2));
  };

  const handleSaveHar = async () => {
    const target = await save({ defaultPath: "packetlens.har", filters: [{ name: "HAR", extensions: ["har"] }] });
    if (!target) {
      return;
    }
    const har = {
      log: {
        version: "1.2",
        creator: { name: "PacketLens", version: "0.1.0" },
        entries: records.map((record) => ({
          startedDateTime: new Date(record.started * 1000).toISOString(),
          time: record.duration_ms,
          request: {
            method: record.method,
            url: record.url,
            httpVersion: "HTTP/1.1",
            headers: record.request_headers,
            queryString: [],
            headersSize: -1,
            bodySize: record.request_body_size,
            postData: record.request_body ? { mimeType: "", text: record.request_body } : undefined,
          },
          response: {
            status: record.status_code,
            statusText: record.error || "",
            httpVersion: "HTTP/1.1",
            headers: record.response_headers ?? [],
            headersSize: -1,
            bodySize: record.response_body_size,
            content: { size: record.response_body_size, mimeType: "", text: record.response_body },
          },
        })),
      },
    };
    await writeTextFile(target, JSON.stringify(har, null, 2));
  };

  const handleLoad = async () => {
    const file = await open({ filters: [{ name: "Capture", extensions: ["json", "har"] }] });
    if (!file || Array.isArray(file)) {
      return;
    }
    const data = await readTextFile(file);
    if (file.toLowerCase().endsWith(".har")) {
      const parsed = JSON.parse(data);
      const entries = parsed?.log?.entries ?? [];
      const loaded = entries.map((entry: any, idx: number) => ({
        id: `${idx}-${entry.startedDateTime}`,
        started: Date.parse(entry.startedDateTime) / 1000,
        ended: Date.parse(entry.startedDateTime) / 1000,
        duration_ms: entry.time ?? 0,
        method: entry.request?.method ?? "",
        url: entry.request?.url ?? "",
        host: new URL(entry.request?.url ?? "http://localhost").host,
        path: new URL(entry.request?.url ?? "http://localhost").pathname,
        scheme: new URL(entry.request?.url ?? "http://localhost").protocol.replace(":", ""),
        status_code: entry.response?.status ?? 0,
        request_headers: entry.request?.headers ?? [],
        response_headers: entry.response?.headers ?? [],
        request_body_size: entry.request?.bodySize ?? 0,
        response_body_size: entry.response?.bodySize ?? 0,
        request_body: entry.request?.postData?.text ?? "",
        response_body: entry.response?.content?.text ?? "",
        request_body_truncated: false,
        response_body_truncated: false,
        error: "",
      })) as FlowRecord[];
      setRecords(loaded);
    } else {
      const loaded = JSON.parse(data) as FlowRecord[];
      setRecords(loaded);
    }
  };

  const handleClear = () => {
    setRecords([]);
    setSelectedId("");
  };

  const handleOpenCertFolder = async () => {
    try {
      await invoke("open_cert_folder");
    } catch (error) {
      window.alert(String(error));
    }
  };

  const handleInstallCert = async () => {
    try {
      await invoke("install_cert");
    } catch (error) {
      window.alert(String(error));
    }
  };

  const handleUninstallCert = async () => {
    try {
      await invoke("uninstall_cert");
    } catch (error) {
      window.alert(String(error));
    }
  };

  const handleOpenBrowser = async () => {
    try {
      if (proxyState === "starting") {
        window.alert("Proxy is still starting. Please wait a moment and try again.");
        return;
      }
      if (proxyState !== "running") {
        window.alert("Capture is not running yet. Click Start and wait for Running status.");
        return;
      }
      const basePort = activeProxyPort ?? (Number(port) || 8192);
      const nextPort = basePort + 1;
      await requestProxyStartAndAutoOpenBrowser(nextPort);
    } catch (error) {
      window.alert(String(error));
    }
  };

  const handleHowToUse = () => {
    window.alert("Use Start Capture to begin capture. Set filters, click rows to inspect details.");
  };

  const handleAutoScroll = () => {
    setAutoScroll(true);
    window.requestAnimationFrame(() => {
      scrollToLatest();
    });
  };

  const renderColumnFilter = (col: ColumnKey) => (
    <input
      className="column-filter"
      placeholder="%PATTERN%"
      value={columnFilters[col]}
      onChange={(event) => setColumnFilters((prev) => ({ ...prev, [col]: event.target.value }))}
      onClick={(event) => event.stopPropagation()}
    />
  );

  const selectedBody = detailsTab === "request" ? selected?.request_body ?? "" : selected?.response_body ?? "";
  const selectedHeaders = detailsTab === "request" ? selected?.request_headers ?? [] : selected?.response_headers ?? [];
  const selectedJson = prettyJson(selectedBody);
  const selectedJsonTree = tryParseJson(selectedBody);
  const rawDetails = selected
    ? detailsTab === "request"
      ? [
          `${selected.method} ${selected.url}`,
          `Host: ${selected.host}`,
          `Scheme: ${selected.scheme}`,
          `Request Body Size: ${selected.request_body_size}`,
          `Request Body Truncated: ${selected.request_body_truncated}`,
          "",
          selected.request_body || "No request body",
        ].join("\n")
      : [
          `Status: ${selected.status_code || "--"}`,
          selected.error ? `Error: ${selected.error}` : "",
          `Response Body Size: ${selected.response_body_size}`,
          `Response Body Truncated: ${selected.response_body_truncated}`,
          "",
          selected.response_body || "No response body",
        ]
          .filter(Boolean)
          .join("\n")
    : "No record selected";

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="panel">
          <h3>Favorites</h3>
          <ul className="tree">
            <li>Pinned</li>
            <li className="muted">(empty)</li>
            <li>Saved</li>
            <li className="muted">(empty)</li>
          </ul>
        </div>

        <div className="panel">
          <h3>Filters</h3>
          <label className="field">
            <span>Host Filter</span>
            <input
              placeholder="e.g. api.example.com"
              value={hostFilter}
              onChange={(event) => setHostFilter(event.target.value)}
            />
          </label>
          <label className="field">
            <span>Search</span>
            <input
              placeholder="Search URL, header, body..."
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          </label>
        </div>

        <div className="panel">
          <h3>Domains</h3>
          <ul className="tree">
            <li>example.com</li>
            <li>cdn.example.com</li>
            <li className="muted">badhost.local</li>
          </ul>
        </div>
      </aside>

      <main className="main">
        <header className="toolbar">
          <div className="toolbar-left">
            <label className="inline-field">
              <span>Listen Port</span>
              <input value={port} onChange={(event) => setPort(event.target.value)} />
            </label>
            <label className="inline-field browser-select-field">
              <span>Browser</span>
              <select value={browserTarget} onChange={(event) => setBrowserTarget(event.target.value as BrowserTarget)}>
                <option value="edge">Edge</option>
                <option value="chrome">Chrome</option>
                <option value="firefox">Firefox</option>
                <option value="brave">Brave</option>
              </select>
            </label>
            <div className="toolbar-actions">
              <button
                className="btn primary"
                onClick={startCapture}
                disabled={proxyState === "starting" || proxyState === "running"}
              >
                {proxyState === "starting" ? "Starting..." : "Start Capture"}
              </button>
              <button className="btn" onClick={stopCapture} disabled={proxyState === "stopped"}>
                Stop Capture
              </button>
              <button
                className="btn"
                onClick={togglePause}
                disabled={proxyState !== "running" && proxyState !== "paused"}
              >
                {paused ? "Resume" : "Pause"}
              </button>
            </div>
          </div>
          <div className="toolbar-right">
            <div className="status-wrap">
              <span className={`capture-indicator ${isCaptureOn ? "on" : "off"}`} aria-label={isCaptureOn ? "Capture on" : "Capture off"} />
              <div className="status">{statusText}</div>
            </div>
            <button className="btn about-btn" onClick={() => setShowAbout(true)} title="About PacketLens">
              <img src={appIcon} alt="" aria-hidden className="about-icon" />
              About
            </button>
          </div>
        </header>

        <section className="button-grid">
          <button className="btn grid-btn" onClick={handleSaveJson}>
            <span className="icon-swatch" aria-hidden />
            Save JSON
          </button>
          <button className="btn grid-btn" onClick={handleSaveHar}>
            <span className="icon-swatch" aria-hidden />
            Save HAR
          </button>
          <button className="btn grid-btn" onClick={handleLoad}>
            <span className="icon-swatch" aria-hidden />
            Load Capture
          </button>
          <button className="btn grid-btn" onClick={handleClear}>
            <span className="icon-swatch" aria-hidden />
            Clear
          </button>
          <button className="btn grid-btn" onClick={handleOpenCertFolder}>
            <span className="icon-swatch" aria-hidden />
            Open Cert Folder
          </button>
          <button className="btn grid-btn" onClick={handleInstallCert}>
            <span className="icon-swatch" aria-hidden />
            Install Cert
          </button>
          <button className="btn grid-btn" onClick={handleUninstallCert}>
            <span className="icon-swatch" aria-hidden />
            Uninstall Cert
          </button>
          <button className="btn grid-btn" onClick={handleOpenBrowser}>
            <span className="icon-swatch" aria-hidden />
            Open Browser
          </button>
          <button className="btn grid-btn" onClick={handleHowToUse}>
            <span className="icon-swatch" aria-hidden />
            How To Use
          </button>
          {["All", "HTTP", "HTTPS", "WebSocket", "JSON", "XML", "JS", "CSS", "Other"].map((label) => (
            <button
              key={label}
              className={`btn grid-btn secondary ${activeFilter === label ? "active" : ""}`}
              onClick={() => setActiveFilter(label)}
            >
              <span className="icon-swatch" aria-hidden />
              {label}
            </button>
          ))}
        </section>

        <div className="content-split" ref={contentSplitRef}>
          <section className="table-panel" style={tablePanelHeight !== null ? { height: `${tablePanelHeight}px` } : undefined}>
            <div className="table-panel-actions">
              <button className={`btn table-auto-scroll ${autoScroll ? "active" : ""}`} onClick={handleAutoScroll}>
                Auto Scroll
              </button>
            </div>
            <div className="table-scroll" ref={tableScrollRef}>
              <table>
                <thead>
                  <tr>
                    <th style={{ width: columnWidths.time, minWidth: columnWidths.time }} onClick={() => toggleSort("time")}>
                      {renderHeader("time", "Time")}
                    </th>
                    <th style={{ width: columnWidths.method, minWidth: columnWidths.method }} onClick={() => toggleSort("method")}>
                      {renderHeader("method", "Method")}
                    </th>
                    <th style={{ width: columnWidths.host, minWidth: columnWidths.host }} onClick={() => toggleSort("host")}>
                      {renderHeader("host", "Host")}
                    </th>
                    <th style={{ width: columnWidths.path, minWidth: columnWidths.path }} onClick={() => toggleSort("path")}>
                      {renderHeader("path", "Path")}
                    </th>
                    <th style={{ width: columnWidths.status, minWidth: columnWidths.status }} onClick={() => toggleSort("status")}>
                      {renderHeader("status", "Status")}
                    </th>
                    <th style={{ width: columnWidths.size, minWidth: columnWidths.size }} onClick={() => toggleSort("size")}>
                      {renderHeader("size", "Resp Size")}
                    </th>
                    <th style={{ width: columnWidths.duration, minWidth: columnWidths.duration }} onClick={() => toggleSort("duration")}>
                      {renderHeader("duration", "Duration")}
                    </th>
                  </tr>
                  <tr className="filters-row">
                    <th style={{ width: columnWidths.time, minWidth: columnWidths.time }}>{renderColumnFilter("time")}</th>
                    <th style={{ width: columnWidths.method, minWidth: columnWidths.method }}>{renderColumnFilter("method")}</th>
                    <th style={{ width: columnWidths.host, minWidth: columnWidths.host }}>{renderColumnFilter("host")}</th>
                    <th style={{ width: columnWidths.path, minWidth: columnWidths.path }}>{renderColumnFilter("path")}</th>
                    <th style={{ width: columnWidths.status, minWidth: columnWidths.status }}>{renderColumnFilter("status")}</th>
                    <th style={{ width: columnWidths.size, minWidth: columnWidths.size }}>{renderColumnFilter("size")}</th>
                    <th style={{ width: columnWidths.duration, minWidth: columnWidths.duration }}>{renderColumnFilter("duration")}</th>
                  </tr>
                </thead>
                <tbody>
                  {sortedRecords.map((record) => (
                    <tr
                      key={record.id}
                      className={[
                        record.status_code >= 400 || record.status_code === 0 ? "row-error" : "",
                        record.id === selectedId ? "row-selected" : "",
                      ]
                        .filter(Boolean)
                        .join(" ")}
                      onClick={() => {
                        setSelectedId(record.id);
                        setAutoScroll(false);
                      }}
                    >
                      <td style={{ width: columnWidths.time, minWidth: columnWidths.time }} title={new Date(record.started * 1000).toLocaleTimeString()}>
                        <div className="cell-text">{new Date(record.started * 1000).toLocaleTimeString()}</div>
                      </td>
                      <td style={{ width: columnWidths.method, minWidth: columnWidths.method }} title={record.method}>
                        <div className="cell-text">{record.method}</div>
                      </td>
                      <td style={{ width: columnWidths.host, minWidth: columnWidths.host }} title={record.host}>
                        <div className="cell-text">{record.host}</div>
                      </td>
                      <td style={{ width: columnWidths.path, minWidth: columnWidths.path }} title={record.path}>
                        <div className="cell-text">{record.path}</div>
                      </td>
                      <td style={{ width: columnWidths.status, minWidth: columnWidths.status }} title={String(record.status_code || "--")}>
                        <div className="cell-text">{record.status_code || "--"}</div>
                      </td>
                      <td style={{ width: columnWidths.size, minWidth: columnWidths.size }} title={String(record.response_body_size)}>
                        <div className="cell-text">{record.response_body_size}</div>
                      </td>
                      <td style={{ width: columnWidths.duration, minWidth: columnWidths.duration }} title={formatDuration(record.duration_ms)}>
                        <div className="cell-text">{formatDuration(record.duration_ms)}</div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
          <div
            className="table-panel-resize-line"
            onMouseDown={(event) => {
              const panelEl = event.currentTarget.previousElementSibling as HTMLElement | null;
              if (!panelEl) {
                return;
              }
              panelResizeStateRef.current = {
                startY: event.clientY,
                startHeight: panelEl.getBoundingClientRect().height,
              };
            }}
          />

          <section className="details">
            <div className="details-controls">
              <button
                className={`btn details-btn ${detailsTab === "request" ? "active" : ""}`}
                onClick={() => setDetailsTab("request")}
              >
                Request
              </button>
              <button
                className={`btn details-btn ${detailsTab === "response" ? "active" : ""}`}
                onClick={() => setDetailsTab("response")}
              >
                Response
              </button>
              <span className="details-controls-spacer" />
              {(["raw", "headers", "json", "tree"] as const).map((tab) => (
                <button
                  key={tab}
                  className={`btn details-btn ${subTab === tab ? "active" : ""}`}
                  onClick={() => setSubTab(tab)}
                >
                  {tab.toUpperCase()}
                </button>
              ))}
            </div>
            <div className="details-body">
              {subTab === "raw" ? <pre>{rawDetails}</pre> : null}
              {subTab === "headers" ? <pre>{formatHeaders(selectedHeaders)}</pre> : null}
              {subTab === "json" ? <pre>{selectedJson || "Body is not valid JSON"}</pre> : null}
              {subTab === "tree" ? (
                selectedJsonTree ? (
                  renderJsonTreeRoot(selectedJsonTree)
                ) : (
                  <pre>Body is not valid JSON</pre>
                )
              ) : null}
            </div>
          </section>
        </div>
      </main>
      {showAbout ? (
        <div className="about-overlay" onClick={() => setShowAbout(false)}>
          <div className="about-modal" onClick={(event) => event.stopPropagation()}>
            <div className="about-header">
              <img src={appIcon} alt="" aria-hidden className="about-logo" />
              <div className="about-title-group">
                <h3>PacketLens</h3>
                <p>Desktop traffic capture and inspection suite.</p>
                <span className="about-badge">Windows Edition</span>
              </div>
            </div>
            <div className="about-content">
              <p className="about-lead">
                Capture, inspect, and troubleshoot HTTP(S) and WebSocket traffic with a fast and focused desktop workflow.
              </p>
              <p>
                Developed by{" "}
                <a href="https://github.com/shailz25" target="_blank" rel="noreferrer">
                  <strong>Shailz25</strong>
                </a>
              </p>
              <p>
                GitHub:{" "}
                <a href="https://github.com/shailz25" target="_blank" rel="noreferrer">
                  github.com/shailz25
                </a>
              </p>
              <p>Free to use for learning and day-to-day analysis.</p>
            </div>
            <div className="about-actions">
              <span className="about-rights">All Rights Reserved (C) 2026 Shailz25</span>
              <button className="btn" onClick={() => setShowAbout(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
}

export default App;
