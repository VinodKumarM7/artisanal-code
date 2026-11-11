# Simple patterns by language

The plain, standard way to handle common situations, for the `simplify-review` skill. The project's own conventions come first: if `.artisanal/profile.json` or the surrounding code shows the team already does something a certain way, follow that, even where it differs from this page. Use this page when the project has no clear habit, or to judge whether added structure pays for itself.

## Everywhere

- **Fewer layers.** A function, class or file has to earn its place: more than one caller, a real boundary (I/O, a framework hook, a test seam), or a name that makes a call site clearer. Otherwise inline it.
- **One way per project.** Do not introduce a second error-handling, logging, config or data-access style next to the existing one.
- **Errors propagate by default.** Catch only where you can do something useful: retry, translate to a domain error at a boundary, add context, or report to the user. A catch that only logs, rethrows the same error, or swallows it is noise.
- **No speculative generality.** No interface, factory, strategy, options object or plugin hook until there is a second real case.
- **Names say what, not how.** `invoiceTotal`, not `result`; `sendReminder`, not `handleData`.
- **Behavior first.** A simplification that could change behavior (exceptions, ordering, side effects, public API) is flagged, not applied.

## JavaScript and TypeScript

| Situation | Simple pattern | Instead of |
|---|---|---|
| Sharing code | Plain ES modules exporting functions | Classes with only static methods, singletons |
| A few related helpers | A module named for the domain (`pricing.js`) | `utils.js`, `helpers.js` |
| Optional values | `?.` and `??` at the point of use | Null checks on values just created, or deep defensive guards |
| Config | A module that reads env once and exports values | Config classes, per-call option merging for one use |
| Async errors | `await` and let it throw; one `try/catch` at the boundary (route handler, CLI main) | `try/catch` around every await, `.catch(() => {})` |
| Types (TS) | Inline or local types; `interface` for object shapes used in several places | An interface per class, `I`-prefixed names, types for single-use literals |
| Data transforms | `map`, `filter`, `reduce`, `for...of` | Hand-rolled helpers duplicating the standard library |
| State in React | Local state, lift when shared; context for cross-cutting values | A global store for one component's state |
| Logging | The project's logger, or `console.error` for real errors in CLIs | `console.log` left from debugging |

## Python

| Situation | Simple pattern | Instead of |
|---|---|---|
| Sharing code | Module-level functions | Classes with no state, `Manager`/`Helper` classes |
| Data records | `@dataclass` (or the project's Pydantic models) | Dicts passed everywhere, hand-written `__init__` boilerplate |
| Errors | Catch the specific exception (`except FileNotFoundError:`), `raise ... from err` when translating | Bare `except:`, `except Exception: pass`, catching to log and continue |
| Resources | `with` blocks | Manual `open`/`close` with `try/finally` |
| Optional values | Early `return` / `if x is None` where `None` is a real possibility | `None` checks on values that cannot be `None` |
| Config | Environment read in one settings module | Config classes used once, globals scattered across modules |
| Logging | `logger = logging.getLogger(__name__)` | `print` in library code |
| Interfaces | Duck typing; `Protocol` only when a type checker needs it and there are several implementations | ABCs with one subclass |
| Scripts | `if __name__ == "__main__":` with `argparse` | Top-level code that runs on import |

## Apex (Salesforce)

| Situation | Simple pattern | Instead of |
|---|---|---|
| Triggers | One trigger per object that calls a handler class; logic in the handler | Logic in the trigger body, several triggers per object |
| Queries | A selector class per object when queries repeat; inline SOQL when used once | A generic query builder, dynamic SOQL without need |
| Business logic | A service class with static methods per domain area | Factories and interfaces with one implementation |
| Bulk safety | Collect IDs, query once outside loops, DML on lists | SOQL or DML inside loops |
| Errors | Let exceptions propagate to the platform, or catch to add a user-facing message (`addError`) | `catch (Exception e) { System.debug(e); }` |
| Sharing and security | `with sharing` by default; `WITH USER_MODE` or `Security.stripInaccessible` for user data | `without sharing` without a stated reason |
| Config | Custom metadata or custom settings | Hardcoded IDs, config classes |
| Tests | `@isTest` classes with `@TestSetup` data, `Assert` methods, a bulk (200 record) case | `SeeAllData=true`, tests with no assertions |
| Logging | Remove `System.debug` before release, or use the org's logging framework | `System.debug` left in production code |

Fuller frameworks (fflib Domain/Selector/Service/Unit of Work) are fine when the project already uses them; do not add one to a project that does not.

## Java

| Situation | Simple pattern | Instead of |
|---|---|---|
| Services | A concrete class injected by the framework (Spring `@Service`) | `FooService` interface plus `FooServiceImpl` with one implementation |
| Data | `record` types (Java 16+) or the project's entity classes | Mutable beans with only getters and setters for value objects |
| Errors | Throw specific exceptions; catch at boundaries; `try`-with-resources for I/O | `catch (Exception e) {}`, `catch (Throwable t)`, `e.printStackTrace()` |
| Construction | Constructors or static factory methods on the class | Factory classes that always build one type, builders for two fields |
| Optional values | `Optional` for return values that may be empty | `Optional` fields or parameters, null checks on `new` results |
| Logging | The project's SLF4J logger | `System.out.println` outside `main` |
| Utilities | Methods on the class that owns the data, or a small final class named for its domain | `Utils`/`Helper` classes with unrelated static methods |
