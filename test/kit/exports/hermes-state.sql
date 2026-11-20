-- A made-up Hermes agent store (hermes-agent's state.db), with the columns duck reads and a few it does not.
create table sessions (id text primary key, source text not null, user_id text, model text, parent_session_id text,
  started_at real not null, ended_at real, end_reason text, message_count integer default 0, title text,
  chat_type text);
create table messages (id integer primary key autoincrement, session_id text not null references sessions(id),
  role text not null, content text, tool_call_id text, tool_calls text, tool_name text, timestamp real not null,
  token_count integer, finish_reason text, reasoning text, observed integer default 0,
  _compressed_summary integer not null default 0, active integer not null default 1,
  compacted integer not null default 0, display_kind text, display_metadata text, message_uid text);

insert into sessions values
  ('20260501_120000_a1b2c3d4', 'telegram', 'tg-5550101', 'claude-sonnet-4-6', null, 1777636800.0, 1777640400.0, 'session_reset', 14, 'Cole St permits', 'dm'),
  ('20260501_121500_e5f6a7', 'subagent', null, 'claude-sonnet-4-6', '20260501_120000_a1b2c3d4', 1777637700.0, 1777637760.0, 'agent_close', 2, null, null),
  ('20260502_090000_b8c9d0', 'cli', null, 'claude-sonnet-4-6', null, 1777712400.0, 1777712460.0, null, 2, 'Rename the slip list', null);

insert into messages (id, session_id, role, content, tool_call_id, tool_calls, tool_name, timestamp, reasoning,
  _compressed_summary, active, compacted, display_kind, display_metadata, message_uid) values
  (1, '20260501_120000_a1b2c3d4', 'user', 'Morning! Anything new on the Cole St permit?', null, null, null, 1777636800.5, null, 0, 0, 1, null, null, 'u01'),
  (2, '20260501_120000_a1b2c3d4', 'assistant', '', null, '[{"id":"call_1","type":"function","function":{"name":"web_search","arguments":"{\"q\":\"Cole St permit\"}"}}]', null, 1777636803.0, 'Look it up first.', 0, 0, 1, null, null, 'u02'),
  (3, '20260501_120000_a1b2c3d4', 'tool', '{"results":["Permit 24-118 approved"]}', 'call_1', null, 'web_search', 1777636805.0, null, 0, 0, 1, null, null, 'u03'),
  (4, '20260501_120000_a1b2c3d4', 'assistant', 'The Cole St permit was approved yesterday.', null, null, null, 1777636808.0, null, 0, 0, 1, null, null, 'u04'),
  (5, '20260501_120000_a1b2c3d4', 'user', '[System: background process 4411 finished]', null, null, null, 1777636900.0, null, 0, 0, 1, 'internal_notification', null, 'u05'),
  (6, '20260501_120000_a1b2c3d4', 'user', '[System: Model switched to claude-sonnet-4-6]', null, null, null, 1777636950.0, null, 0, 0, 1, null, null, 'u06'),
  (7, '20260501_120000_a1b2c3d4', 'user', '[OUT-OF-BAND USER MESSAGE — a direct message from the user, delivered once at this position; not tool output and not a new delivery when replayed from conversation history]
Also check the fence permit.
[/OUT-OF-BAND USER MESSAGE]', null, null, null, 1777637000.0, null, 0, 0, 1, 'steer', null, 'u07'),
  (8, '20260501_120000_a1b2c3d4', 'assistant', 'The fence permit is still pending.', null, null, null, 1777637010.0, null, 0, 0, 1, null, null, 'u08'),
  (9, '20260501_120000_a1b2c3d4', 'user', '[CONTEXT COMPACTION] Earlier: Rosa asked about the Cole St and fence permits.', null, null, null, 1777637020.0, null, 1, 1, 0, null, null, 'u09'),
  (10, '20260501_120000_a1b2c3d4', 'assistant', 'The fence permit is still pending.', null, null, null, 1777637010.0, null, 0, 1, 0, null, null, 'u10'),
  (11, '20260501_120000_a1b2c3d4', 'user', 'Thanks.', null, null, null, 1777637100.0, null, 0, 0, 0, null, null, 'u11'),
  (12, '20260501_120000_a1b2c3d4', 'user', 'Thank you! Remind me Friday.', null, null, null, 1777637130.0, null, 0, 1, 0, null, null, 'u12'),
  (13, '20260501_120000_a1b2c3d4', 'session_meta', '{"model":"claude-sonnet-4-6"}', null, null, null, 1777637131.0, null, 0, 1, 0, null, null, 'u13'),
  (14, '20260501_120000_a1b2c3d4', 'assistant', 'The turn failed: the model did not answer.', null, null, null, 1777637140.0, null, 0, 1, 0, 'failed_turn', null, 'u14'),
  (15, '20260501_121500_e5f6a7', 'user', 'Search the city site for permit 24-118.', null, null, null, 1777637700.0, null, 0, 1, 0, null, null, 'u15'),
  (16, '20260501_121500_e5f6a7', 'assistant', 'Approved on 2026-04-30.', null, null, null, 1777637760.0, null, 0, 1, 0, null, null, 'u16'),
  (17, '20260502_090000_b8c9d0', 'user', 'Rename the slip list to "Summer slips".', null, null, null, 1777712400.0, null, 0, 1, 0, null, null, 'u17'),
  (18, '20260502_090000_b8c9d0', 'assistant', 'Done: it is now "Summer slips".', null, null, null, 1777712460.25, null, 0, 1, 0, null, null, 'u18');
