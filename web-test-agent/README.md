# 🤖 web-test-agent

> **Nghiên cứu khoa học**: "Nghiên cứu và xây dựng AI Agent hỗ trợ kiểm thử ứng dụng Web"

Hệ thống AI Agent tự động khám phá, sinh test case và thực thi kiểm thử ứng dụng Web.  
Sử dụng Claude (Anthropic) làm LLM backbone, Playwright để tương tác browser.

---

## 📐 Tech Stack

| Component | Technology |
|-----------|-----------|
| Language | TypeScript 5.x |
| Runtime | Node.js ≥ 20 (LTS) |
| Browser Automation | Playwright |
| LLM | @anthropic-ai/sdk (Claude) |
| Schema Validation | Zod |
| Database | SQLite via better-sqlite3 |
| Logging | pino |
| Test Runner | Jest + ts-jest |

**Không sử dụng:** LangChain, LangGraph, hay bất kỳ AI framework nào khác.

---

## 🚀 Quick Start

### 1. Yêu cầu hệ thống

- **Node.js** ≥ 20.0.0 (LTS) — tải tại [nodejs.org](https://nodejs.org)
- **Git**

### 2. Cài đặt dependencies

```bash
cd web-test-agent
npm install
```

### 3. Cài Playwright browsers

```bash
npx playwright install chromium
# Hoặc cài tất cả browsers:
# npx playwright install
```

### 4. Cấu hình environment

```bash
cp .env.example .env
# Chỉnh sửa .env và thêm ANTHROPIC_API_KEY (cần thiết từ M2+)
```

### 5. Build TypeScript

```bash
npm run build
```

Output sẽ nằm trong thư mục `dist/`.

### 6. Chạy test

```bash
# Chạy tất cả tests
npm run test

# Chạy smoke test M0
npm run test:smoke

# Chỉ chạy unit tests
npm run test:unit

# Chỉ chạy e2e tests
npm run test:e2e
```

### 7. Chạy development

```bash
npm run dev
```

### 8. Type check (không build)

```bash
npm run typecheck
```

---

## 📁 Cấu trúc thư mục

```
web-test-agent/
├── src/
│   ├── orchestrator/       # M1: Điều phối toàn bộ pipeline
│   │   └── orchestrator.ts
│   ├── planner/            # M2: Sinh TestPlan từ UserRequest + LLM
│   │   └── planner.ts
│   ├── explorer/           # M1: BFS/DFS khám phá trạng thái Web
│   │   ├── explorer.ts
│   │   ├── dom-extractor.ts
│   │   └── state-hash.ts
│   ├── generator/          # M3: Sinh TestCase từ StateGraph
│   │   └── test-generator.ts
│   ├── grounding/          # M3: Ánh xạ mô tả ngôn ngữ tự nhiên → Playwright locator
│   │   ├── candidate-gen.ts
│   │   ├── ranking.ts
│   │   ├── llm-fallback.ts
│   │   └── grounding-engine.ts
│   ├── executor/           # M1: Thực thi TestAction qua Playwright
│   │   └── executor.ts
│   ├── observer/           # M2: Ghi lại DOM state, network, console
│   │   └── observer.ts
│   ├── evaluator/          # M4: Đánh giá kết quả test
│   │   ├── rule-evaluator.ts
│   │   ├── semantic-evaluator.ts
│   │   └── evaluator.ts
│   ├── reporter/           # M5: Sinh báo cáo HTML/JSON
│   │   └── reporter.ts
│   ├── memory/             # M3: Lưu trữ locator thành công (SQLite)
│   │   └── locator-memory.ts
│   ├── llm/                # M2: Wrapper cho Anthropic API
│   │   └── llm-client.ts
│   ├── models/             # M0: Zod schemas – source of truth
│   │   └── schemas.ts
│   ├── db/                 # M0: SQLite connection + migrations
│   │   └── db.ts
│   ├── logger.ts           # M0: pino logger
│   └── main.ts             # Entry point
├── tests/
│   ├── unit/               # Unit tests
│   │   └── smoke.test.ts   # M0 smoke test
│   ├── grounding-dataset/  # M3: Dataset đánh giá grounding
│   └── e2e/                # E2E test scenarios
├── demo-site/              # Demo web app để test
├── configs/
│   └── default.json        # Cấu hình mặc định
├── data/                   # SQLite database (không commit)
├── reports/                # Báo cáo generated (không commit)
├── package.json
├── tsconfig.json
├── jest.config.ts
├── .env.example
├── .gitignore
└── README.md
```

---

## ⚙️ Cấu hình

File cấu hình chính: [`configs/default.json`](configs/default.json)

| Key | Default | Mô tả |
|-----|---------|--------|
| `explorer.max_depth` | 5 | Độ sâu tối đa khi khám phá |
| `explorer.max_states` | 200 | Số trạng thái tối đa |
| `llm.max_llm_calls` | 500 | Giới hạn LLM calls |
| `grounding.confidence_threshold` | 0.75 | Ngưỡng tin cậy grounding |
| `grounding.ambiguity_threshold` | 0.15 | Ngưỡng phát hiện mơ hồ |
| `executor.timeout_ms` | 30000 | Timeout mỗi action (ms) |
| `executor.retry_count` | 3 | Số lần retry |

---

## 🗺️ Roadmap

| Milestone | Tên | Nội dung |
|-----------|-----|----------|
| **M0** ✅ | Project Setup | Cấu trúc, dependencies, schemas, SQLite, logging |
| **M1** | Executor thô | Playwright executor cơ bản, chạy hardcoded actions |
| **M2** | LLM Client + Observer | Anthropic API wrapper, ghi lại DOM/network/console |
| **M3** | Grounding Engine | Ánh xạ NL → locator, memory, LLM fallback |
| **M4** | Explorer + State Graph | BFS crawl, state hash, StateGraph builder |
| **M5** | Planner | LLM-based TestPlan generation |
| **M6** | Test Generator | Sinh TestCase từ StateGraph + TestPlan |
| **M7** | Evaluator | Rule + Semantic evaluation |
| **M8** | Reporter | HTML/JSON reports |
| **M9** | Self-healing | Tự phục hồi locator khi DOM thay đổi |
| **M10** | Integration | End-to-end pipeline hoàn chỉnh |
| **M11** | Evaluation & Demo | Benchmark, demo-site, paper metrics |

---

## 📄 License

MIT – Đề tài nghiên cứu khoa học, không dùng cho mục đích thương mại.
