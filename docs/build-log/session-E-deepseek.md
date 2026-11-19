# Build log: session-E-deepseek

- 15:43 | E | DeepSeek adapter: report via forced strict tool call (no json_schema response_format) | live smoke result: strict mode on /beta accepted all 4 tool schemas + ReportApi (no keyword rejected, nothing stripped); chat → 6 valid parallel tool calls; forced submit_report → valid JSON, Report.safeParse failed on 2 empty supporting_observation_ids (min-1 rule ReportApi can't express → schema_violation → repair round, as designed); model reported deepseek-flash | Groq free tier couldn't fit one investigation
