export type HeaderEntry = {
  name: string;
  value: string;
};

export type FlowRecord = {
  id: string;
  started: number;
  ended: number;
  duration_ms: number;
  method: string;
  url: string;
  host: string;
  path: string;
  scheme: string;
  status_code: number;
  request_headers: HeaderEntry[];
  response_headers: HeaderEntry[] | null;
  request_body_size: number;
  response_body_size: number;
  request_body: string;
  response_body: string;
  request_body_truncated: boolean;
  response_body_truncated: boolean;
  error: string;
};

export type ProxyStatus = "starting" | "running" | "paused" | "stopped";

export type ProxyStatusEvent = {
  type: "status";
  status: ProxyStatus;
  message?: string;
  port?: number;
};

export type ProxyErrorEvent = {
  type: "error";
  message: string;
};

export type FlowEvent = {
  type: "flow";
  record: FlowRecord;
};

export type ProxyEvent = ProxyStatusEvent | ProxyErrorEvent | FlowEvent;

export type ProxyCommand =
  | { type: "start"; port: number }
  | { type: "stop" }
  | { type: "pause" }
  | { type: "resume" };
