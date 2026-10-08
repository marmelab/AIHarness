// The report page's behaviour. Loaded and inlined by scripts/run-report.mjs.
//
// It lives in its own file for one reason: assembled inside a template literal, the
// page's own prose kept closing it. A backtick in a comment, a double quote in a
// tooltip: four separate breakages, each producing a page that rendered its layout
// and then died on the first line of script. Here it is plain JavaScript that node
// parses, prettier formats, and a test can check.
//
// Its only input is the JSON the generator embeds in the #data element.

const D = JSON.parse(document.getElementById("data").textContent);

/* --- two languages, one page ---
   The definitions are the reason this page can be trusted, so they have to be readable by
   whoever opens it. Keys rather than inline literals: a figure whose title is translated
   but whose definition is not is worse than one in a single language. */
const L = {
  title: ["Session stats", "Statistiques de session"],
  windowed: [
    "the run is the span its harness agents cover; the host session's own turns are excluded",
    "le run est la fenêtre que couvrent ses agents du harness ; les tours de la session hôte sont exclus",
  ],
  solo: [
    "no harness agent: the run is the whole session",
    "pas d'agent du harness : le run est la session entière",
  ],
  boom: ["This report failed to draw", "Ce rapport n'a pas pu être dessiné"],

  preambleTax: [
    ["Preamble tax", "Taxe de préambule"],
    [
      "Every turn re-reads its whole context, and the top of that context is the same on every turn of every agent: the system prompt, the tool definitions, the skill listing and the injected instruction files. This is that header multiplied by the turns that re-read it, as a share of everything the run re-read. It is the part of the bill that bought nothing the dispatch asked for, and it is the one that shrinks by deleting text.",
      "Chaque tour relit tout son contexte, et le haut de ce contexte est identique à chaque tour de chaque agent : system prompt, définitions d'outils, listing de skills, fichiers d'instructions injectés. C'est cet en-tête multiplié par les tours qui le relisent, rapporté à tout ce que le run a relu. C'est la part de la facture qui n'a rien acheté de ce que le dispatch demandait, et la seule qui diminue en supprimant du texte.",
    ],
  ],
  coordination: [
    ["Coordination", "Coordination"],
    [
      "The short gaps inside the run window where no agent had a turn in flight: one has stopped, the next has not started. This is the harness's own turnaround, and it is the part that a deterministic script would remove. Gaps past five minutes are counted as stalls instead, because averaging one 90-minute pause together with 183 two-second ones describes neither.",
      "Les courts trous dans la fenêtre du run où aucun agent n'avait de tour en vol : l'un s'est arrêté, le suivant n'a pas démarré. C'est le délai de relance propre au harness, et c'est la part qu'un script déterministe supprimerait. Les trous de plus de cinq minutes comptent comme des blocages, car moyenner une pause de 90 minutes avec 183 pauses de deux secondes ne décrit ni l'une ni les autres.",
    ],
  ],
  stalls: [
    ["Stalls", "Blocages"],
    [
      "Gaps of five minutes or more where nothing ran. Each is an incident with its own cause, listed beside this rather than averaged: a human at a gate, a suite that hung, a session picked up later. Recorded hook executions do not explain them — on a measured run 1544 of them totalled under a minute — but note that SubagentStop hooks are absent from transcripts, so a validation chain running on an agent's stop would appear here with nothing to name it.",
      "Trous de cinq minutes ou plus où rien ne tournait. Chacun est un incident avec sa cause propre, listé à côté plutôt que moyenné : un humain devant une porte, une suite qui a pendu, une session reprise plus tard. Les exécutions de hooks enregistrées ne les expliquent pas (sur un run mesuré, 1544 d'entre elles totalisaient moins d'une minute), mais attention : les hooks SubagentStop sont absents des transcripts, donc une chaîne de validation lancée à l'arrêt d'un agent apparaîtrait ici sans rien pour la nommer.",
    ],
  ],
  pStalls: [
    ["The stalls, one by one", "Les blocages, un par un"],
    [
      "Every gap of five minutes or more, longest first, with the moment it started. These are worth opening individually; there are too few of them for an average to mean anything.",
      "Chaque trou de cinq minutes ou plus, du plus long au plus court, avec l'instant où il a commencé. Ils méritent d'être ouverts un par un : ils sont trop peu nombreux pour qu'une moyenne veuille dire quelque chose.",
    ],
  ],
  pDispatches: [
    ["Dispatches", "Dispatches"],
    [
      "Calls that spawn an agent or ask a human. Their duration is that other party's time, not work this agent did, so they are kept out of the tool ranking where they would otherwise sit on top for the wrong reason. The child's own row carries those minutes.",
      "Les appels qui lancent un agent ou interrogent un humain. Leur durée est le temps de l'autre partie, pas du travail fait par cet agent : ils sont donc hors du classement des outils, où ils trôneraient pour une mauvaise raison. Les minutes en question sont portées par la ligne de l'enfant.",
    ],
  ],
  unusedDead: [
    ["Dead time", "Temps mort"],
    [
      "Time inside the run window during which NO agent was producing a turn. On a dispatch-driven harness this is the orchestrator's turnaround: one agent has stopped, the next has not started, and a model is deciding what to do next. It is not the model working and it is not a human: it is the coordination itself, and it is the latency the harness owns.",
      "Temps dans la fenêtre du run pendant lequel AUCUN agent ne produisait de tour. Sur un harness piloté par dispatch, c'est le délai de relance de l'orchestrateur : un agent s'est arrêté, le suivant n'a pas démarré, un modèle décide de la suite. Ce n'est ni le modèle qui travaille ni un humain : c'est la coordination elle-même, et c'est la latence dont le harness est responsable.",
    ],
  ],
  busy: [
    ["Busy", "Occupé"],
    [
      "Time inside the run window with at least one agent producing a turn. Its complement is the dead time beside it.",
      "Temps dans la fenêtre du run avec au moins un agent qui produit un tour. Son complément est le temps mort à côté.",
    ],
  ],
  perTurn: [
    ["Cost per turn", "Coût par tour"],
    [
      "The run's cost divided by its turns. A turn is the billing unit, because it re-reads the whole context whatever it then does, so this figure moves with context size far more than with what the agent accomplished.",
      "Le coût du run divisé par ses tours. Le tour est l'unité de facturation, puisqu'il relit tout le contexte quoi qu'il fasse ensuite : ce chiffre suit la taille du contexte bien plus que ce que l'agent a accompli.",
    ],
  ],
  errorRate: [
    ["Tool calls that failed", "Appels d'outils en échec"],
    [
      "Calls whose result came back flagged as an error. Each one is a turn spent, a context re-read and, usually, a retry: the cost is roughly double what the number suggests.",
      "Appels dont le résultat est revenu marqué en erreur. Chacun est un tour dépensé, un contexte relu et, en général, une reprise : le coût est à peu près le double de ce que le nombre laisse croire.",
    ],
  ],
  longestAgent: [
    ["Longest agent", "Agent le plus long"],
    [
      "The single agent that ran longest. With work spread over many agents, the run cannot finish faster than this one, whatever the parallelism.",
      "L'agent qui a tourné le plus longtemps. Avec du travail réparti sur beaucoup d'agents, le run ne peut pas finir plus vite que celui-là, quel que soit le parallélisme.",
    ],
  ],
  pErrors: [
    ["Where the failures are", "Où sont les échecs"],
    [
      "Failed calls per tool. A shell command failing one time in ten is usually a wrong path or a guard refusing; either way the agent pays a full turn to find out.",
      "Appels en échec par outil. Une commande shell qui échoue une fois sur dix, c'est en général un mauvais chemin ou un garde qui refuse ; dans les deux cas l'agent paie un tour entier pour l'apprendre.",
    ],
  ],
  pTokens: [
    ["Tokens, and what each kind costs", "Tokens, et ce que coûte chaque type"],
    [
      "The four kinds are not interchangeable. A cache read costs a tenth of fresh input, a five-minute cache write costs 1.25 times it, an hour-long one twice, and output costs several times input. So the largest column in tokens is rarely the largest in money: on a measured run, 52M cache-read tokens cost less than 0.5M output tokens. The dollars are an estimate at the public API rates, which is not what a subscription bills; the tokens are measured, and they are what a usage limit counts.",
      "Les quatre types ne sont pas interchangeables. Une lecture de cache coûte un dixième d'un input frais, une écriture de cache 5 min 1,25 fois, une écriture 1 h le double, et la sortie plusieurs fois l'input. La plus grosse colonne en tokens est donc rarement la plus grosse en argent : sur un run mesuré, 52 M de tokens lus en cache coûtent moins que 0,5 M de tokens de sortie. Les dollars sont une estimation aux tarifs API publics, qui ne sont pas ce que facture un abonnement ; les tokens, eux, sont mesurés, et ce sont eux que compte une limite d'usage.",
    ],
  ],
  pModels: [
    ["Models used", "Modèles utilisés"],
    [
      "Every model that produced a turn in the run window, with its cost, the tokens it read and wrote, and its generation time (the gaps before its turns, under 5 min each), each with its share of the run. A model the pricing table has no rate for is priced at the fallback rate and tagged so. Click a row for the agents that used it.",
      "Chaque modèle qui a produit un tour dans la fenêtre du run, avec son coût, les tokens qu'il a lus et écrits, et son temps de génération (les écarts avant ses tours, sous 5 min chacun), chacun avec sa part du run. Un modèle sans tarif dans la table de prix est chiffré au tarif par défaut, et marqué comme tel. Cliquez une ligne pour les agents qui l'ont utilisé.",
    ],
  ],
  pPreamble: [
    ["The preamble, per role", "Le préambule, par rôle"],
    [
      "What each role is handed before its task, averaged over its agents, and what re-reading it costs across that role's turns.",
      "Ce que chaque rôle reçoit avant sa tâche, moyenné sur ses agents, et ce que coûte sa relecture sur les tours de ce rôle.",
    ],
  ],
  working: [
    ["Working time", "Temps de travail"],
    [
      "Busy time plus the short turnarounds between agents: the stretch during which this run was actually being carried out. Every time share on this page is taken against it, because the end-to-end span is not a usable base — a run is a session, and a session resumed the next morning spans a night nobody worked.",
      "Le temps occupé plus les courtes relances entre agents : la durée pendant laquelle ce run était réellement en cours. Toutes les parts de temps de cette page y sont rapportées, car l'empan de bout en bout n'est pas une base utilisable : un run est une session, et une session reprise le lendemain matin couvre une nuit où personne n'a travaillé.",
    ],
  ],
  wallClock: [
    ["End to end", "De bout en bout"],
    [
      "From the first harness agent to the last, clock on the wall. A run is a session, and a session can be paused and resumed days later, so this can read six days of which four hours were work. It is reported because it is the truth about the calendar, and it is the base of no percentage on this page for exactly that reason. The pauses that make it large are listed beside it as stalls.",
      "Du premier au dernier agent du harness, à l'horloge. Un run est une session, et une session peut être mise en pause puis reprise des jours plus tard : cela peut donc afficher six jours dont quatre heures de travail. C'est rapporté parce que c'est la vérité du calendrier, et cela ne sert de base à aucun pourcentage de cette page, précisément pour cette raison. Les pauses qui le gonflent sont listées à côté comme blocages.",
    ],
  ],
  agentTime: [
    ["Agent time", "Temps agent"],
    [
      "Tool work plus generation, summed OVER THE AGENTS. With agents running in parallel it exceeds the wall clock, and the ratio between the two is the parallelism.",
      "Travail outil plus génération, sommés SUR LES AGENTS. Avec des agents en parallèle, ce total dépasse le temps réel, et le rapport entre les deux est le parallélisme.",
    ],
  ],
  parallel: [
    ["Parallelism", "Parallélisme"],
    [
      "Agent time divided by BUSY time, not by the window. At 1.0 the agents ran one after another; at 3.0 three were working on average while anything was running at all. Dividing by the window would credit the run for its dead time.",
      "Temps agent divisé par le temps OCCUPÉ, pas par la fenêtre. À 1,0 les agents se sont succédé ; à 3,0 trois travaillaient en moyenne pendant que quelque chose tournait. Diviser par la fenêtre créditerait le run de son temps mort.",
    ],
  ],
  pLegend: [
    ["What the activities mean", "Ce que veulent dire les activités"],
    [
      "Every tool call is put in exactly one bucket, from its tool name and, for a shell command, from what the command does.",
      "Chaque appel d'outil va dans exactement un bac, d'après son nom d'outil et, pour une commande shell, d'après ce que fait la commande.",
    ],
  ],
  activeTime: [
    ["Active time", "Temps actif"],
    [
      "The run window: the span its harness agents cover. Wall-clock, merged so two agents working at once count once. A gap between two turns counts up to 5 min; past that it is idle and excluded.",
      "La fenêtre du run : la durée que couvrent ses agents du harness. Temps réel, fusionné pour que deux agents simultanés comptent une fois. Un écart entre deux tours compte jusqu'à 5 min ; au delà il est inactif et exclu.",
    ],
  ],
  toolWork: [
    ["Tool work", "Travail outil"],
    [
      "Sum of tool-call durations, merged so calls fired together in one turn count once. A call is timed from its tool_use entry to its tool_result entry, capped at 15 min.",
      "Somme des durées d'appels d'outils, fusionnée pour que des appels lancés ensemble comptent une fois. Un appel est chronométré de son entrée tool_use à son entrée tool_result, plafonné à 15 min.",
    ],
  ],
  waiting: [
    ["Generation + hooks", "Génération + hooks"],
    [
      "The gaps between turns, each counted up to 5 min. This is essentially the model writing its next turn. The hooks the transcript records are NOT in here — each carries the id of the call it belongs to, so it ran inside that call, and all of them together come to under five minutes across the whole archive. The one hook that would land in this gap is SubagentStop, where the validation chain runs, and a transcript never records it: if that is what you are chasing, hooks.log is the only source, and it must survive for you to read it.",
      "Les écarts entre tours, comptés jusqu'à 5 min chacun. C'est pour l'essentiel le modèle qui écrit son tour suivant. Les hooks que le transcript enregistre n'y sont PAS : chacun porte l'identifiant de l'appel auquel il appartient, donc il a tourné dans cet appel, et tous réunis ils font moins de cinq minutes sur toute l'archive. Le seul hook qui atterrirait dans cet écart est SubagentStop, où tourne la chaîne de validation, et un transcript ne l'enregistre jamais : si c'est ce que vous cherchez, hooks.log est la seule source, et encore faut-il qu'il ait survécu.",
    ],
  ],
  ratio: [
    ["Wait per minute acting", "Attente par minute d'action"],
    [
      "Generation+hooks divided by tool work. Above 1, the run spends longer producing text than running anything.",
      "Génération+hooks divisé par le travail outil. Au dessus de 1, le run passe plus de temps à produire du texte qu'à exécuter quoi que ce soit.",
    ],
  ],
  cost: [
    ["Cost", "Coût"],
    [
      "An ESTIMATE at the public API rates, not what a subscription bills: on a plan, what is actually metered is tokens. Priced per turn from the transcript's own usage figures, each turn at its own model's rate, over the turns inside the run window only. Cache reads at 0.1x input, 5-minute cache writes at 1.25x, 1-hour at 2x. Useful for comparing runs and roles; not a figure to put in an invoice.",
      "Une ESTIMATION aux tarifs API publics, pas ce que facture un abonnement : sur un forfait, ce qui est réellement compté, ce sont les tokens. Facturé par tour depuis les usages du transcript, chaque tour au tarif de son propre modèle, sur les seuls tours dans la fenêtre du run. Lectures de cache à 0,1x input, écritures de cache 5 min à 1,25x, 1 h à 2x. Utile pour comparer des runs et des rôles ; pas un chiffre à mettre sur une facture.",
    ],
  ],
  ctxBefore: [
    ["Context before the task", "Contexte avant la tâche"],
    [
      "System prompt + tool definitions + skill listing + injected instruction files, read from the transcript's attachments, before the dispatch prompt. The token figure is bytes/4, an estimate.",
      "System prompt + définitions d'outils + listing de skills + fichiers d'instructions injectés, lus dans les attachments du transcript, avant le prompt de dispatch. Le chiffre en tokens est octets/4, une estimation.",
    ],
  ],
  idle: [
    ["Idle, excluded", "Inactif, exclu"],
    [
      "The part of each between-turns gap beyond 5 min: a session resumed the next day, a tab left open. Excluded from every other figure on this page.",
      "La part de chaque écart entre tours au delà de 5 min : une session reprise le lendemain, un onglet laissé ouvert. Exclue de tous les autres chiffres de cette page.",
    ],
  ],
  outside: [
    ["Outside the run", "Hors du run"],
    [
      "Turns of the main thread before or after the harness agents' window. Real spend, but the developer's own interactive work, not the harness's.",
      "Tours du thread principal avant ou après la fenêtre des agents du harness. Dépense réelle, mais le travail interactif du développeur, pas celui du harness.",
    ],
  ],
  turns: [
    ["Turns", "Tours"],
    [
      "The run window only. One turn is one assistant response. A response streamed over several transcript lines is still one turn, and it re-reads its whole context whatever it then does.",
      "Fenêtre du run uniquement. Un tour est une réponse de l'assistant. Une réponse diffusée sur plusieurs lignes du transcript reste un seul tour, et elle relit tout son contexte quoi qu'elle fasse ensuite.",
    ],
  ],
  calls: [
    ["Tool calls", "Appels d'outils"],
    [
      "The run window only, one per tool_use block. Errored means the tool_result came back flagged. Stalled means it took over 15 min, which is almost always a result that landed after an interruption rather than a long command.",
      "Fenêtre du run uniquement, un par bloc tool_use. En erreur : le tool_result est revenu marqué comme tel. Bloqué : plus de 15 min, ce qui est presque toujours un résultat arrivé après une interruption plutôt qu'une commande longue.",
    ],
  ],
  medianCall: [
    ["Median call", "Appel médian"],
    [
      "Over EVERY timed call of the run, not the ones this page lists. Durations past 15 min are counted as 15 min.",
      "Sur TOUS les appels chronométrés du run, pas seulement ceux que cette page liste. Les durées au delà de 15 min sont comptées comme 15 min.",
    ],
  ],
  p95Call: [
    ["95th percentile call", "Appel au 95e percentile"],
    [
      "Over every timed call of the run. The gap between this and the median is where the occasional slow command lives.",
      "Sur tous les appels chronométrés du run. L'écart entre ce chiffre et la médiane, c'est là que vit la commande lente occasionnelle.",
    ],
  ],
  largestCtx: [
    ["Largest context", "Plus grand contexte"],
    [
      "The largest single turn's context: fresh input + cache read + cache write. This is the amount re-read on that turn, which is what a long agent actually costs.",
      "Le contexte du tour le plus lourd : input frais + lecture de cache + écriture de cache. C'est la quantité relue à ce tour, et c'est ce que coûte vraiment un agent qui dure.",
    ],
  ],
  repeated: [
    ["Repeated work", "Travail répété"],
    [
      "Time inside identical repeated calls, third-and-later reads of one file, retries after an error, and re-dispatches. Counts the repeats only, never the first attempt.",
      "Temps passé dans des appels identiques répétés, les relectures à partir de la troisième, les reprises après erreur et les redispatches. Ne compte que les répétitions, jamais la première tentative.",
    ],
  ],

  supervise: [
    ["Supervision", "Supervision"],
    [
      "Time a parent agent spent inside an Agent call, which lasts exactly as long as the child it spawned. The parent executed nothing during it, and the child's own row already carries those minutes, so this is EXCLUDED from tool work and from agent time. Counting it was 51% of one run's reported work.",
      "Temps passé par un agent parent dans un appel Agent, qui dure exactement aussi longtemps que l'enfant qu'il a lancé. Le parent n'exécute rien pendant ce temps, et la ligne de l'enfant porte déjà ces minutes : c'est donc EXCLU du travail outil et du temps agent. Le compter représentait 51 % du travail annoncé d'un run.",
    ],
  ],
  human: [
    ["Waiting on a human", "Attente d'un humain"],
    [
      "Time inside an AskUserQuestion call, and nothing else: the agent was idle while somebody read the question. A person pausing between two messages is not this — it has no tool call to measure and lands in the stalls instead. Excluded from tool work and from agent time.",
      "Temps passé dans un appel AskUserQuestion, et rien d'autre : l'agent ne faisait rien pendant que quelqu'un lisait la question. Une personne qui marque une pause entre deux messages n'est pas comptée ici — il n'y a pas d'appel d'outil à mesurer, et cela se retrouve dans les blocages. Exclu du travail outil et du temps agent.",
    ],
  ],
  hookTime: [
    ["Hook time, measured", "Temps de hook, mesuré"],
    [
      "The transcript records every PreToolUse, PostToolUse, Stop and SessionStart execution with its exact duration, so this is measured and not inferred. Each one carries the id of the call it belongs to, which means it ran INSIDE that call's duration, not in the gap between turns. Across the whole archive these total under five minutes for nine thousand executions, the slowest averaging 84 ms. What is NOT here is SubagentStop, which a transcript never records and which is where the validation chain runs: those only ever appear in hooks.log.",
      "Le transcript enregistre chaque exécution de PreToolUse, PostToolUse, Stop et SessionStart avec sa durée exacte : ce chiffre est mesuré, pas déduit. Chacune porte l'identifiant de l'appel auquel elle appartient, ce qui veut dire qu'elle a tourné DANS la durée de cet appel, pas dans l'écart entre deux tours. Sur toute l'archive elles totalisent moins de cinq minutes pour neuf mille exécutions, la plus lente à 84 ms de moyenne. Ce qui n'est PAS ici, c'est SubagentStop, qu'un transcript n'enregistre jamais et où tourne la chaîne de validation : celles-là n'apparaissent que dans hooks.log.",
    ],
  ],
  pComposition: [
    ["Where the run's minutes went", "Où sont passées les minutes du run"],
    [
      "The run's clock split two ways. Idle is named but not drawn: on some runs it is 20x everything else and flattens the rest into a hairline.",
      "L'horloge du run coupée en deux. L'inactif est nommé mais pas dessiné : sur certains runs il vaut 20x tout le reste et écrase le reste en un trait.",
    ],
  ],
  pByActivity: [
    ["Tool work by activity", "Travail outil par activité"],
    [
      "What the agents DID, so waiting and idling are absent by construction. Each call is bucketed by its tool and, for Bash, by what the command does.",
      "Ce que les agents ont FAIT : l'attente et l'inactif en sont absents par construction. Chaque appel est classé par son outil et, pour Bash, par ce que fait la commande.",
    ],
  ],
  pCostRole: [
    ["Cost by role", "Coût par rôle"],
    [
      "Summed per turn inside the run window, so the host session's own work is not charged to whichever role happened to run alongside it.",
      "Somme par tour dans la fenêtre du run, pour que le travail propre à la session hôte ne soit pas imputé au rôle qui tournait à côté.",
    ],
  ],
  pHistogram: [
    ["Call duration distribution", "Distribution des durées d'appel"],
    [
      "Every timed call, on a log scale: most calls are fast and a few are not, which a linear axis hides. Hover a bar for its range and count.",
      "Tous les appels chronométrés, en échelle log : la plupart sont rapides, quelques uns non, ce qu'un axe linéaire cache. Survolez une barre pour sa plage et son compte.",
    ],
  ],
  pCtxFill: [
    [
      "What fills a context before the task",
      "Ce qui remplit un contexte avant la tâche",
    ],
    [
      "Averaged per role over the agents of this run. Read from the transcript's attachments, so it is what was actually sent, not what a config says should be.",
      "Moyenne par rôle sur les agents de ce run. Lu dans les attachments du transcript : c'est ce qui a réellement été envoyé, pas ce qu'une config annonce.",
    ],
  ],
  pCtxGrowth: [
    ["Context growth per turn", "Croissance du contexte par tour"],
    [
      "One line per agent, coloured by role. The y axis is the context re-read on that turn; the starting height is the tile above. Hover a line for the agent it belongs to.",
      "Une ligne par agent, colorée par rôle. L'axe y est le contexte relu à ce tour ; la hauteur de départ est la tuile ci dessus. Survolez une ligne pour l'agent auquel elle appartient.",
    ],
  ],
  pTools: [
    ["Tools by time", "Outils par temps"],
    [
      "Summed call time per tool, so a tool called often and briefly can outrank a slow one. MCP tools are shown without their server prefix.",
      "Temps d'appel cumulé par outil : un outil appelé souvent et brièvement peut devancer un outil lent. Les outils MCP sont affichés sans leur préfixe de serveur.",
    ],
  ],
  pLongest: [
    ["Longest single tool calls", "Appels d'outils les plus longs"],
    [
      "One row per individual call, longest first. A 'stalled' tag means the raw duration exceeded 15 min and was capped there: look at it before believing it.",
      "Une ligne par appel individuel, du plus long au plus court. Une étiquette 'stalled' veut dire que la durée brute dépassait 15 min et a été plafonnée : regardez-la avant d'y croire.",
    ],
  ],
  pLoops: [
    ["Going in circles", "Tours en rond"],
    [
      "repeat-call: the identical call again. reread: a third read of one file. error-retry: a failure followed by a near-identical attempt. redispatch: the same role asked for the same thing twice.",
      "repeat-call : le même appel à l'identique. reread : une troisième lecture d'un fichier. error-retry : un échec suivi d'une tentative quasi identique. redispatch : le même rôle redemande la même chose.",
    ],
  ],
  pWaitAfter: [
    [
      "Generation after each kind of tool",
      "Génération après chaque type d'outil",
    ],
    [
      "Which tool results the model is slow to answer. Each row groups the turns that followed a turn of one activity: after N turns of <activity>, the model took <time> in total to produce its next turn, and that turn averaged <avg output> tokens. A long time with a small output is the model reading and weighing what the tool returned, such as a long test log; a large output is the model writing. Subagents only, since the main thread's gaps are a person typing. Turns that follow a dispatch or a question are left out: the model was reading another agent's or a person's answer, not a tool's.",
      "Les résultats d'outils auxquels le modèle met du temps à répondre. Chaque ligne groupe les tours qui suivent un tour d'une activité : après N tours d'<activité>, le modèle a mis <temps> au total à produire son tour suivant, et ce tour a fait <sortie moy.> tokens en moyenne. Un temps long pour une sortie courte, c'est le modèle qui lit et pèse ce que l'outil a renvoyé, comme un long log de tests ; une grosse sortie, c'est le modèle qui écrit. Sous-agents uniquement, car les écarts du thread principal sont quelqu'un qui tape. Les tours qui suivent un dispatch ou une question sont exclus : le modèle lisait la réponse d'un autre agent ou d'une personne, pas celle d'un outil.",
    ],
  ],
  pFiles: [
    ["Files touched most", "Fichiers les plus touchés"],
    [
      "Counted over every call that named exactly one file, so a Grep across a directory is absent. A file read many times by one agent is usually context that fell out.",
      "Compté sur chaque appel ayant nommé exactement un fichier : un Grep sur un répertoire en est absent. Un fichier lu plusieurs fois par un même agent, c'est en général du contexte qui est tombé.",
    ],
  ],
  pHooks: [
    ["Hooks that ran", "Hooks qui ont tourne"],
    [
      "From the transcript, which records every hook execution with its duration and exit code. A non-zero exit is a hook that refused or failed; the transcript does not say which, only hooks.log carries the message.",
      "Depuis le transcript, qui enregistre chaque exécution de hook avec sa durée et son code de sortie. Une sortie non nulle est un hook qui a refusé ou échoué ; le transcript ne dit pas lequel, seul hooks.log porte le message.",
    ],
  ],
  pTimeline: [
    ["Agent timeline", "Chronologie des agents"],
    [
      "One lane per agent, one band per tool call, placed when it ran and coloured by what it did. The lane rule spans the agent's life; the empty stretches are waiting, and they are deliberately not drawn as a bar. Hover a band for its call, and anywhere else on a lane for the agent: its task, turns, calls, largest context, cost and model, over the run window.",
      "Une voie par agent, une bande par appel d'outil, placée au moment où il a tourné et colorée par ce qu'il faisait. Le filet couvre la vie de l'agent ; les vides sont l'attente, délibérément pas dessinée en barre. Survolez une bande pour son appel, et le reste d'une voie pour l'agent : sa tâche, ses tours, ses appels, son plus grand contexte, son coût et son modèle, sur la fenêtre du run.",
    ],
  ],
};

/* Short chrome, in the same two columns. */
const S = {
  agents: ["agents", "agents"],
  ofReread: ["% of everything re-read", "% de tout ce qui est relu"],
  ofWindow: ["% of the run window", "% de la fenêtre du run"],
  ofWorking: ["% of the working time", "% du temps de travail"],
  endToEnd: [
    "first to last subagent, pauses included",
    "du premier au dernier sous-agent, pauses comprises",
  ],
  betweenAgents: [
    "between one agent and the next",
    "entre un agent et le suivant",
  ],
  incidents: ["gaps of 5 min or more", "trous de 5 min ou plus"],
  hWhen: ["started at", "a commencé à"],
  hLastBefore: ["last thing before it", "dernière chose avant"],
  clickForWhy: [
    "click to see what bracketed it",
    "cliquer pour voir ce qui l'encadre",
  ],
  hasHookTrace: [
    "hooks.log covers this gap, so the hook lines inside it are shown",
    "hooks.log couvre ce trou, donc les lignes de hook qu'il contient sont affichées",
  ],
  noHookTrace: [
    "no hooks.log for this session, so a validation chain running here would leave no trace. Point HARNESS_TMP_ROOT somewhere /tmp does not sweep to capture it next time.",
    "pas de hooks.log pour cette session : une chaîne de validation qui tournerait ici ne laisserait aucune trace. Pointez HARNESS_TMP_ROOT ailleurs que dans /tmp pour la capturer la prochaine fois.",
  ],
  stallAt: ["Stall at", "Blocage à"],
  lastBefore: ["last call before", "dernier appel avant"],
  firstAfter: ["first call after", "premier appel après"],
  hHowLong: ["lasted", "a duré"],
  ofSubTurns: ["of subagent turns", "des tours de sous-agents"],
  ofCalls: ["of all calls", "de tous les appels"],
  nobodyWorking: ["nobody was working", "personne ne travaillait"],
  atLeastOne: ["at least one agent working", "au moins un agent au travail"],
  hRole: ["role", "rôle"],
  hPreamble: ["preamble", "préambule"],
  hKind: ["kind", "type"],
  redactedBadge: ["redacted: figures only", "expurgé : chiffres seulement"],
  unpricedBadge: ["no rate for", "pas de tarif pour"],
  unpricedAny: ["a model of this session", "un modèle de cette session"],
  pricedStale: [
    "priced before its models had a rate: ingest it again",
    "chiffré avant que ses modèles aient un tarif : relancer l'ingest",
  ],
  hookRuns: ["recorded executions", "exécutions enregistrées"],
  noSubagentStop: [
    "SubagentStop not among them",
    "SubagentStop n'en fait pas partie",
  ],
  hTokens: ["tokens", "tokens"],
  hShareTok: ["% tok", "% tok"],
  hShareUsd: ["% $", "% $"],
  hReread: ["re-read", "relu"],
  hCost: ["cost", "coût"],
  sSummary: [
    "Where the money and the time went",
    "Où sont passés l'argent et le temps",
  ],
  sWork: [
    "What the agents actually did",
    "Ce que les agents ont réellement fait",
  ],
  sWaste: ["Waste", "Gâchis"],
  sRoles: ["Per role", "Par rôle"],

  parallelSuffix: ["x parallel", "x en parallèle"],
  ofAgentTime: ["% of agent time", "% du temps agent"],
  inWindow: ["in the run window", "dans la fenêtre du run"],
  outsideShort: ["outside", "hors run"],
  stalledWhat: [
    "the raw duration was over 15 min and was capped there. Almost always a result that landed after the session was interrupted, not a long command.",
    "la durée brute dépassait 15 min et a été plafonnée. Presque toujours un résultat arrivé après une interruption de session, pas une commande longue.",
  ],
  clickForCalls: ["click for its calls", "cliquer pour ses appels"],
  clickForInside: [
    "click to see what is inside",
    "cliquer pour voir ce qu'il y a dedans",
  ],
  hItem: ["item", "élément"],
  noBreakdown: [
    "the transcript records this part as one size, with no list of what makes it up",
    "le transcript enregistre cette part comme une taille unique, sans liste de ce qui la compose",
  ],
  inventoryOnly: [
    "listed to every agent of the run; the transcript records the names, not a size each",
    "listées à chaque agent du run ; le transcript enregistre les noms, pas une taille par skill",
  ],
  dragToZoom: [
    "drag across the chart to zoom in",
    "glissez sur le graphe pour zoomer",
  ],
  zoomOn: ["zoomed on", "zoom sur"],
  reset: ["show the whole run", "revenir au run entier"],
  blockedOnChildren: [
    "blocked on child agents, excluded",
    "bloqué sur des agents enfants, exclu",
  ],
  blockedOnHuman: [
    "blocked on a human, excluded",
    "bloqué sur un humain, exclu",
  ],
  superviseExcluded: ["supervising, excluded", "supervision, exclue"],
  humanExcluded: ["waiting on a human, excluded", "attente humaine, exclue"],
  blockedTag: ["blocked", "bloqué"],
  blockedTagWhat: [
    "this tool's duration is somebody else's time: a spawned agent, or a human reading a question. It is not work this agent did.",
    "la durée de cet outil est le temps de quelqu'un d'autre : un agent lancé, ou un humain qui lit une question. Ce n'est pas du travail fait par cet agent.",
  ],
  allCalls: ["all calls", "tous les appels"],
  skipped: ["skipped", "sauté"],
  close: ["close", "fermer"],
  hModel: ["model", "modèle"],
  hGen: ["generation", "génération"],
  hAgents: ["agents", "agents"],
  defaultRate: ["fallback rate", "tarif par défaut"],
  dAgents: ["agents that used it", "agents qui l'ont utilisé"],
  dCalls: ["calls, longest first", "appels, du plus long au plus court"],
  dByTool: ["by tool", "par outil"],
  dBySkill: ["by skill loaded", "par skill chargée"],
  hSkill: ["skill", "skill"],

  ofRun: ["% of the run", "% du run"],
  outTok: ["output tokens", "tokens de sortie"],
  medianAgent: ["median agent", "agent médian"],
  notRecorded: ["not recorded", "non enregistré"],
  openNotWorking: [
    "session open, not working",
    "session ouverte, sans travail",
  ],
  hostTurns: ["turns of the host session", "tours de la session hôte"],
  noToolCall: ["with no tool call", "sans appel d'outil"],
  errored: ["errored", "en erreur"],
  stalledN: ["stalled", "bloqués"],
  callsTimed: ["calls timed", "appels chronométrés"],
  max: ["max", "max"],
  medianTurn: ["median turn", "tour médian"],
  repeatsFound: ["repeats found", "répétitions trouvées"],
  noneFound: ["none found", "aucune"],
  waitsMore: ["waits more than it acts", "attend plus qu'il n'agit"],
  actsMore: ["acts more than it waits", "agit plus qu'il n'attend"],
  longestCalls: ["longest calls", "appels les plus longs"],
  noCtxAttach: [
    "this run predates the context attachments",
    "ce run est antérieur aux attachments de contexte",
  ],
  noTimed: ["no timed agent", "aucun agent chronométré"],
  noData: ["no data", "pas de données"],
  nothing: ["nothing", "rien"],
  callsWord: ["calls", "appels"],
  toWord: ["to", "a"],
  toolWorkLabel: ["tool work", "travail outil"],
  genLabel: ["generation + hooks", "génération + hooks"],
  acting: ["acting", "à agir"],
  generating: ["generating", "à générer"],
  idleExcluded: ["idle, excluded", "inactif, exclu"],
  turn: ["turn", "tour"],
  hAgent: ["agent", "agent"],
  hTurns: ["turns", "tours"],
  hCalls: ["calls", "appels"],
  hCtxMax: ["ctx max", "ctx max"],
  hTool: ["tool", "outil"],
  hN: ["n", "n"],
  hTime: ["time", "temps"],
  hErr: ["err", "err"],
  hToolArg: ["tool - argument", "outil - argument"],
  hActivity: ["activity", "activité"],
  hTook: ["took", "durée"],
  hWhat: ["what", "quoi"],
  hKind: ["kind", "type"],
  hTimes: ["times", "fois"],
  hWasted: ["wasted", "perdu"],
  hAfter: ["after", "après"],
  hAvgOut: ["avg output", "sortie moy."],
  hFile: ["file", "fichier"],
  hSize: ["size", "taille"],
  hHook: ["hook", "hook"],
  hRuns: ["runs", "exécs"],
  hNonZero: ["non-zero exit", "sortie non nulle"],
};

/* Activity and context-component names are identifiers in the store, but labels on screen. */
const ACT_FR = {
  explore: "exploration",
  write: "écriture",
  validate: "validation",
  exec: "exécution",
  runtime: "app",
  dispatch: "dispatch",
  git: "git",
  integration: "intégration",
  wait: "attente",
  idle: "inactif",
  skill: "skill",
  research: "recherche",
  ask: "question",
  bookkeeping: "intendance",
  contract: "contrat",
  think: "réflexion",
  other: "autre",
};
const CTX_FR = {
  tools: "outils",
  instructions: "instructions",
  skills: "skills",
  system: "système",
  session: "session",
  environment: "environnement",
  model: "modèle",
};

/* What each activity bucket actually contains. The names are short because they are column
   headings; the definition is what makes them usable. */
const ACT_DEF = {
  explore: [
    "Reading and searching: Read, Grep, Glob, a read-only shell command, a symbol lookup.",
    "Lire et chercher : Read, Grep, Glob, une commande shell en lecture seule, une recherche de symbole.",
  ],
  write: [
    "Editing files: Edit and Write, nothing else.",
    "Modifier des fichiers : Edit et Write, rien d'autre.",
  ],
  validate: [
    "The project's own checks: the commands harness.config.json declares, plus the usual typecheck, lint and test runners.",
    "Les vérifications du projet : les commandes déclarées dans harness.config.json, plus les typecheck, lint et lanceurs de tests usuels.",
  ],
  exec: [
    "A shell command that is none of the others: a build, a script, a package manager.",
    "Une commande shell qui n'est aucune des autres : un build, un script, un gestionnaire de paquets.",
  ],
  runtime: [
    "Driving the application: a browser through Playwright, a curl on localhost, a Supabase command.",
    "Piloter l'application : un navigateur via Playwright, un curl sur localhost, une commande Supabase.",
  ],
  dispatch: [
    "Spawning another agent or talking to one: Agent, Task, SendMessage.",
    "Lancer un autre agent ou lui parler : Agent, Task, SendMessage.",
  ],
  git: [
    "Git plumbing: status, diff, log, commit, branch, worktree.",
    "Plomberie git : status, diff, log, commit, branch, worktree.",
  ],
  integration: [
    "An MCP server other than the browser: Trello, GitHub, documentation.",
    "Un serveur MCP autre que le navigateur : Trello, GitHub, documentation.",
  ],
  skill: ["Loading a skill.", "Charger une skill."],
  research: [
    "Reading the web: WebFetch, WebSearch.",
    "Lire le web : WebFetch, WebSearch.",
  ],
  ask: [
    "Asking the user a question, and waiting for the answer.",
    "Poser une question à l'utilisateur, et attendre la réponse.",
  ],
  bookkeeping: [
    "Harness housekeeping: the progress log, the todo list.",
    "Intendance du harness : le journal de progression, la liste de tâches.",
  ],
  contract: [
    "Reading or writing a ticket file.",
    "Lire ou écrire un fichier de ticket.",
  ],
  think: [
    "A turn that called no tool at all: deliberation, paid at full context price.",
    "Un tour sans aucun appel d'outil : de la délibération, payée au prix du contexte entier.",
  ],
  wait: [
    "The gap between two turns, up to 5 min: the model writing the next turn, plus any hook that ran there.",
    "L'écart entre deux tours, jusqu'à 5 min : le modèle qui écrit le tour suivant, plus tout hook qui y a tourné.",
  ],
  idle: [
    "The part of a gap beyond 5 min: nobody was working. Excluded from every figure.",
    "La part d'un écart au delà de 5 min : personne ne travaillait. Exclue de tous les chiffres.",
  ],
  other: [
    "A tool with no bucket of its own yet.",
    "Un outil qui n'a pas encore son propre bac.",
  ],
};
const actDef = (a) => (ACT_DEF[a] || ["", ""])[lang];

let lang = 0;
try {
  const saved = localStorage.getItem("runAnatomyLang");
  if (saved === "fr") lang = 1;
  else if (saved !== "en" && /^fr/i.test(navigator.language || "")) lang = 1;
} catch {
  /* private window, blocked storage: the default language is still correct */
}
const tr = (k) => (S[k] || ["?", "?"])[lang];
const ttl = (k) => L[k][0][lang];
const tipOf = (k) => L[k][1][lang];
const actLabel = (a) => (lang ? ACT_FR[a] || a : a);
const ctxLabel = (c) => (lang ? CTX_FR[c] || c : c);

/* Fixed slot per activity: a colour means the same thing in every panel and every run.
   Past eight, an activity folds into "other" rather than being handed a ninth hue. */
const SLOT = {
  explore: "s1",
  write: "s2",
  validate: "s3",
  exec: "s4",
  runtime: "s5",
  dispatch: "s6",
  git: "s7",
  integration: "s8",
};
const color = (a) => "var(--" + (SLOT[a] || "s0") + ")";
/* Four groups, and the distinction between the first two is what makes the page honest.
   OWN WORK is what the agent itself executed.
   BLOCKED is a call whose duration is somebody ELSE's time: an Agent call lasts the whole
   life of the child it spawned, an AskUserQuestion lasts as long as the human thinks.
   Counting either as the caller's work overstates the caller AND counts the child twice,
   since the child's own agent already carries those minutes. On one archived run that was
   51% of the reported tool work.
   GENERATION is the gap between turns. IDLE is the part of a gap past five minutes. */
const BLOCKED = new Set(["dispatch", "ask"]);
const NOT_WORK = new Set(["wait", "idle"]);
const isOwnWork = (a) => !NOT_WORK.has(a) && !BLOCKED.has(a);
// Sorted by time, a table would put these on top for a reason unrelated to what they did.
const BLOCKING_TOOLS = new Set(["Agent", "Task", "AskUserQuestion"]);

const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c],
  );
const dur = (ms) => {
  const s = (ms || 0) / 1000;
  if (s < 1) return Math.round(ms || 0) + " ms";
  if (s < 90) return (s < 10 ? s.toFixed(1) : Math.round(s)) + " s";
  const m = s / 60;
  return m < 90
    ? (m < 10 ? m.toFixed(1) : Math.round(m)) + " min"
    : (m / 60).toFixed(1) + " h";
};
const kb = (b) =>
  b >= 1024 ? Math.round(b / 1024) + " KB" : Math.round(b) + " B";
const tok = (b) => K(b / 4) + " tok";
const K = (n) =>
  n >= 1e6
    ? (n / 1e6).toFixed(1) + "M"
    : n >= 1000
      ? (n / 1000).toFixed(n >= 1e5 ? 0 : 1) + "k"
      : String(Math.round(n || 0));
const usd = (n) => "$" + (n || 0).toFixed(n >= 100 ? 0 : 2);
const day = (ms) =>
  ms ? new Date(ms).toISOString().slice(0, 16).replace("T", " ") : "?";
const pct = (a, b) => (b > 0 ? Math.round((a / b) * 100) : 0);
const quantile = (sorted, q) => {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)));
  return sorted[i];
};

/* --- tooltip, on hover intent ---
   The first version showed instantly and followed the cursor on every mousemove, so
   crossing the page flashed a box through a dozen states and the text was unreadable while
   it moved. It now waits for the pointer to settle, and once shown it stays put until the
   pointer leaves the mark it belongs to. */
const TIP_DELAY_MS = 420;
const tip = document.getElementById("tip");
let tipTarget = null;
let tipTimer = 0;

function placeTip(x, y) {
  tip.style.left = Math.min(x + 14, innerWidth - tip.offsetWidth - 8) + "px";
  tip.style.top =
    y - tip.offsetHeight - 14 < 8
      ? y + 18 + "px"
      : y - tip.offsetHeight - 14 + "px";
}
function hideTip() {
  clearTimeout(tipTimer);
  tipTarget = null;
  tip.style.opacity = "0";
}
function markUnder(node) {
  let el = node;
  while (el && el !== document) {
    if (el.dataset && el.dataset.tip !== undefined) return el;
    el = el.parentNode;
  }
  return null;
}
document.addEventListener("mousemove", (e) => {
  const el = markUnder(e.target);
  if (!el) return hideTip();
  if (el === tipTarget) return; // already armed or shown for this mark: leave it alone
  clearTimeout(tipTimer);
  tipTarget = el;
  tip.style.opacity = "0";
  const x = e.clientX;
  const y = e.clientY;
  tipTimer = setTimeout(() => {
    if (tipTarget !== el) return;
    tip.innerHTML =
      "<b>" +
      esc(el.dataset.tip) +
      "</b>" +
      (el.dataset.tip2 ? "<i>" + esc(el.dataset.tip2) + "</i>" : "");
    tip.style.opacity = "1";
    placeTip(x, y);
  }, TIP_DELAY_MS);
});
document.addEventListener("scroll", hideTip, true);

/* --- panel helpers --- */
/* Every figure carries its own definition. None of these numbers means the obvious thing:
   a duration is capped, a cost is windowed, a token count is an estimate. A dashboard that
   does not say so is a dashboard someone will quote wrongly. */
const help = (t, d) =>
  t ? ' data-tip="' + esc(t) + '" data-tip2="' + esc(d || "") + '"' : "";

const panel = (title, body, cls = "", tip = "") =>
  '<div class="p ' +
  cls +
  '"><h2' +
  (tip ? ' class="q"' + help(title, tip) : "") +
  ">" +
  esc(title) +
  "</h2>" +
  body +
  "</div>";
const tileK = (k, big, sub, cls = "") => tile(ttl(k), big, sub, tipOf(k), cls);
const section = (label) => '<h3 class="sect">' + esc(label) + "</h3>";

/** The four billed kinds of token, each with what it weighs and what it costs. */
function tokenKinds(d) {
  const k = d.tokenKinds;
  if (!k) return '<div class="sub2">' + tr("noData") + "</div>";
  const rows = [
    ["cache read", k.cacheRead],
    ["cache write", k.cacheWrite],
    ["output", k.output],
    ["fresh input", k.input],
  ].filter(([, v]) => v && (v.tokens || v.usd));
  const tok = rows.reduce((s, [, v]) => s + v.tokens, 0) || 1;
  const usd = rows.reduce((s, [, v]) => s + v.usd, 0) || 1;
  return topTable(
    [tr("hKind"), tr("hTokens"), tr("hShareTok"), "$", tr("hShareUsd")],
    rows.map(([name, v]) => [
      esc(name),
      K(v.tokens),
      pct(v.tokens, tok) + "%",
      "$" + v.usd.toFixed(2),
      pct(v.usd, usd) + "%",
    ]),
  );
}

/** Per role: the header it is handed, and what re-reading it costs over its turns. */
function preambleTable(d) {
  const byRole = new Map();
  for (const a of d.preamble) {
    const role = a.role || "?";
    if (!byRole.has(role))
      byRole.set(role, { role, n: 0, tokens: 0, turns: 0 });
    const r = byRole.get(role);
    r.n++;
    r.tokens += a.tokens || 0;
    r.turns += a.turns || 0;
  }
  const rows = [...byRole.values()]
    .map((r) => ({
      ...r,
      avg: r.n ? r.tokens / r.n : 0,
      reread: (r.tokens / Math.max(1, r.n)) * r.turns,
    }))
    .sort((a, b) => b.reread - a.reread);
  return topTable(
    [tr("hRole"), tr("hPreamble"), tr("hTurns"), tr("hReread")],
    rows.map((r) => [esc(r.role), K(r.avg) + " tok", r.turns, K(r.reread)]),
  );
}

/** An agent as the page names it everywhere: its role, and the end of its id. */
const agentName = (a) =>
  !a
    ? "?"
    : a.agent_id === "main"
      ? a.role || "main"
      : (a.role || "?") + " " + a.agent_id.slice(-4);

/** What the page knows of one agent, on one line under its name. */
const agentStats = (a) =>
  (a.description ? a.description + "\n" : "") +
  [
    a.turns_in_window + " " + tr("hTurns"),
    a.calls_in_window + " " + tr("hCalls"),
    K(a.ctx_max) + " " + tr("hCtxMax"),
    usd(a.usd_in_window),
    a.model,
  ]
    .filter(Boolean)
    .join(" · ");

/** Per model: what it cost, what it read and wrote, how long it generated. */
function modelRows(d) {
  const by = new Map();
  for (const r of d.models || []) {
    const m = by.get(r.model) || {
      model: r.model,
      usd: 0,
      tokens: 0,
      gen: 0,
      turns: 0,
      agents: new Set(),
    };
    m.usd += r.usd || 0;
    m.tokens += r.tokens || 0;
    m.gen += r.gen_ms || 0;
    m.turns += r.turns || 0;
    m.agents.add(r.agent_id);
    by.set(r.model, m);
  }
  return [...by.values()].sort((a, b) => b.usd - a.usd || b.tokens - a.tokens);
}

function modelsTable(d) {
  const rows = modelRows(d);
  const sum = (k) => rows.reduce((s, r) => s + r[k], 0);
  const usdT = sum("usd"),
    tokT = sum("tokens"),
    genT = sum("gen");
  const share = (v, t) => ' <span class="pc">' + pct(v, t) + "%</span>";
  const unpriced = new Set(d.unpriced || []);
  return (
    '<div id="models">' +
    topTable(
      [
        tr("hModel"),
        "$",
        tr("hTokens"),
        tr("hGen"),
        tr("hTurns"),
        tr("hAgents"),
      ],
      rows.map((r) => [
        '<span class="mono">' +
          esc(r.model) +
          "</span>" +
          (unpriced.has(r.model)
            ? ' <span class="tag bad">' + esc(tr("defaultRate")) + "</span>"
            : ""),
        usd(r.usd) + share(r.usd, usdT),
        K(r.tokens) + share(r.tokens, tokT),
        dur(r.gen) + share(r.gen, genT),
        r.turns,
        r.agents.size,
      ]),
      (cells, i) => ' class="seg" data-model="' + esc(rows[i].model) + '"',
    ) +
    "</div>"
  );
}

const panelK = (k, body, cls = "", extra = "") =>
  panel(ttl(k) + extra, body, cls, tipOf(k));
const tile = (title, big, sub, tip = "", cls = "") =>
  '<div class="p q ' +
  cls +
  '"' +
  help(title, tip) +
  "><h2>" +
  esc(title) +
  "</h2>" +
  '<div class="big">' +
  big +
  "</div>" +
  (sub ? '<div class="sub2">' + sub + "</div>" : "") +
  "</div>";

function donut(items, total, unit) {
  const R = 52,
    r = 32,
    cx = 60,
    cy = 60;
  let a0 = -Math.PI / 2,
    s = "";
  const arc = (a1, a2, fill, tipT, tipD, attr) => {
    const big = a2 - a1 > Math.PI ? 1 : 0;
    const p = (rad, a) =>
      (cx + rad * Math.cos(a)).toFixed(2) +
      " " +
      (cy + rad * Math.sin(a)).toFixed(2);
    return (
      '<path class="seg" d="M ' +
      p(R, a1) +
      " A " +
      R +
      " " +
      R +
      " 0 " +
      big +
      " 1 " +
      p(R, a2) +
      " L " +
      p(r, a2) +
      " A " +
      r +
      " " +
      r +
      " 0 " +
      big +
      " 0 " +
      p(r, a1) +
      ' Z" fill="' +
      fill +
      '" stroke="var(--panel)" stroke-width="1.5"' +
      attr +
      ' data-tip="' +
      tipT +
      '" data-tip2="' +
      tipD +
      '"/>'
    );
  };
  for (const it of items) {
    if (!it.v) continue;
    const a1 = a0 + (it.v / total) * Math.PI * 2;
    s += arc(
      a0,
      Math.min(a1, a0 + Math.PI * 1.9999),
      it.fill,
      esc(it.k + " · " + pct(it.v, total) + "% · " + unit(it.v)),
      // The definition, not the value again: a slice reading "app 81%" told nobody what
      // app meant, which is the whole reason to hover it.
      esc(it.def || ""),
      it.attr || "",
    );
    a0 = a1;
  }
  return (
    '<svg viewBox="0 0 120 120" role="img">' +
    s +
    "</svg>" +
    '<div class="leg">' +
    items
      .filter((i) => i.v)
      .slice(0, 7)
      .map(
        (i) =>
          '<span class="seg"' +
          (i.attr || "") +
          ' data-tip="' +
          esc(i.k) +
          '" data-tip2="' +
          esc(i.def || "") +
          '"><i class="dot" style="background:' +
          i.fill +
          '"></i>' +
          esc(i.k) +
          " " +
          pct(i.v, total) +
          "%</span>",
      )
      .join("") +
    "</div>"
  );
}

function histogram(values, label) {
  if (!values.length) return '<div class="sub2">' + tr("noData") + "</div>";
  const lo = Math.log10(Math.max(1, values[0]));
  const hi = Math.log10(Math.max(10, values[values.length - 1]));
  const N = 22,
    bins = new Array(N).fill(0);
  for (const v of values) {
    const t = (Math.log10(Math.max(1, v)) - lo) / Math.max(0.0001, hi - lo);
    bins[Math.min(N - 1, Math.max(0, Math.floor(t * N)))]++;
  }
  const max = Math.max(...bins, 1);
  const W = 240,
    H = 74,
    bw = W / N;
  let s = "";
  bins.forEach((n, i) => {
    const h = (n / max) * (H - 16);
    const from = Math.pow(10, lo + ((hi - lo) * i) / N);
    const to = Math.pow(10, lo + ((hi - lo) * (i + 1)) / N);
    s +=
      '<rect class="seg" x="' +
      (i * bw + 0.7).toFixed(1) +
      '" y="' +
      (H - 14 - h).toFixed(1) +
      '" width="' +
      (bw - 1.4).toFixed(1) +
      '" height="' +
      Math.max(h, n ? 1.5 : 0).toFixed(1) +
      '" rx="1" fill="var(--accent)" data-tip="' +
      esc(n + " " + tr("callsWord")) +
      '" data-tip2="' +
      esc(dur(from) + " " + tr("toWord") + " " + dur(to)) +
      '"/>';
  });
  s +=
    '<line class="gl" x1="0" x2="' +
    W +
    '" y1="' +
    (H - 13) +
    '" y2="' +
    (H - 13) +
    '"/>';
  s += '<text x="0" y="' + (H - 3) + '">' + esc(dur(values[0])) + "</text>";
  s +=
    '<text x="' +
    W +
    '" y="' +
    (H - 3) +
    '" text-anchor="end">' +
    esc(dur(values[values.length - 1])) +
    "</text>";
  return (
    '<svg viewBox="0 0 ' +
    W +
    " " +
    H +
    '" role="img" aria-label="' +
    esc(label) +
    '">' +
    s +
    "</svg>"
  );
}

/**
 * A top-N table. rowAttrs(cells, i) may return attributes for the row, which is how a
 * row becomes hoverable (its full, untruncated content) or clickable (a drill-down).
 */
function topTable(head, rows, rowAttrs) {
  if (!rows.length) return '<div class="sub2">' + tr("nothing") + "</div>";
  const attrOf = (cells, i) =>
    typeof rowAttrs === "function" ? rowAttrs(cells, i) : rowAttrs || "";
  return (
    '<div class="scroll"><table><thead><tr>' +
    head
      .map((h, i) => '<th class="' + (i ? "r" : "") + '">' + esc(h) + "</th>")
      .join("") +
    "</tr></thead><tbody>" +
    rows
      .map(
        (cells, i) =>
          "<tr" +
          attrOf(cells, i) +
          ">" +
          cells
            .map(
              (c, j) =>
                '<td class="' + (j ? "r" : "trunc") + '">' + c + "</td>",
            )
            .join("") +
          "</tr>",
      )
      .join("") +
    "</tbody></table></div>"
  );
}

/* --- what an agent was handed before it read its task --- */
const CTX_PARTS = [
  ["tools", "s1"],
  ["instructions", "s2"],
  ["skills", "s3"],
  ["system", "s4"],
  ["session", "s5"],
  ["environment", "s6"],
  ["model", "s7"],
];
const ctxColor = (k) => {
  const hit = CTX_PARTS.find((p) => p[0] === k);
  return "var(--" + (hit ? hit[1] : "s0") + ")";
};

function startingContext(d) {
  // Per role, averaged: two developers in one run are handed the same thing, and the
  // question is what a ROLE starts with, not what one dispatch happened to get.
  const byRole = new Map();
  for (const c of d.context) {
    const role = c.role || "?";
    if (!byRole.has(role))
      byRole.set(role, { role, agents: new Set(), parts: new Map() });
    const r = byRole.get(role);
    r.agents.add(c.agent_id);
    r.parts.set(c.component, (r.parts.get(c.component) || 0) + c.bytes);
  }
  const rows = [...byRole.values()]
    .map((r) => {
      const parts = new Map();
      for (const [k, v] of r.parts) parts.set(k, v / r.agents.size);
      return {
        role: r.role,
        n: r.agents.size,
        parts,
        total: [...parts.values()].reduce((s, v) => s + v, 0),
      };
    })
    .sort((a, b) => b.total - a.total);
  if (!rows.length) return '<div class="sub2">' + tr("noCtxAttach") + "</div>";

  const max = Math.max(...rows.map((r) => r.total), 1);
  const W = 640,
    rowH = 22,
    padL = 118,
    H = rows.length * rowH + 14;
  let s = "";
  rows.forEach((r, i) => {
    const y = i * rowH;
    s +=
      '<text x="' +
      (padL - 6) +
      '" y="' +
      (y + 14) +
      '" text-anchor="end">' +
      esc(r.role) +
      "</text>";
    let x = padL;
    for (const [k] of CTX_PARTS) {
      const v = r.parts.get(k);
      if (!v) continue;
      const w = (v / max) * (W - padL - 58);
      s +=
        '<rect class="seg" x="' +
        x.toFixed(1) +
        '" y="' +
        (y + 4) +
        '" width="' +
        Math.max(0, w - 1.5).toFixed(1) +
        '" height="13" rx="1.5" fill="' +
        ctxColor(k) +
        '" data-ctx="' +
        esc(k) +
        '" data-ctx-role="' +
        esc(r.role) +
        '" data-tip="' +
        esc(r.role + " · " + ctxLabel(k)) +
        '" data-tip2="' +
        esc(kb(v) + " · " + tr("clickForInside")) +
        '"/>';
      x += w;
    }
    s +=
      '<text class="v" x="' +
      (x + 6) +
      '" y="' +
      (y + 14) +
      '">' +
      esc(kb(r.total)) +
      "</text>";
  });
  return (
    '<svg viewBox="0 0 ' +
    W +
    " " +
    H +
    '" role="img" aria-label="Starting context">' +
    s +
    "</svg>" +
    '<div class="leg">' +
    CTX_PARTS.filter(([k]) => rows.some((r) => r.parts.get(k)))
      .map(
        ([k]) =>
          '<span class="seg" data-ctx="' +
          esc(k) +
          '" data-tip="' +
          esc(ctxLabel(k)) +
          '" data-tip2="' +
          esc(tr("clickForInside")) +
          '"><i class="dot" style="background:' +
          ctxColor(k) +
          '"></i>' +
          esc(ctxLabel(k)) +
          "</span>",
      )
      .join("") +
    "</div>"
  );
}

/* --- the timeline: one lane per agent, one band per call ---
   Drawn on a compressed clock. A run can hold a 64-hour gap in the middle, and on a linear
   axis every band then collapses into one pixel at each end with a desert between them.
   Stretches where nothing at all ran are cut to a fixed width and marked, so the axis
   spends its pixels on the parts that have something in them. */
const TIMELINE_GAP_MS = 90000;

function compressedClock(spans, x0, x1, gapPx) {
  const ok = spans
    .filter(
      (s) => Number.isFinite(s[0]) && Number.isFinite(s[1]) && s[1] >= s[0],
    )
    .sort((a, b) => a[0] - b[0]);
  const busy = [];
  for (const [a, b] of ok) {
    const last = busy[busy.length - 1];
    if (last && a - last[1] <= TIMELINE_GAP_MS) last[1] = Math.max(last[1], b);
    else busy.push([a, b]);
  }
  if (!busy.length) return null;
  const total = busy.reduce((sum, [a, b]) => sum + (b - a), 0) || 1;
  const usable = x1 - x0 - (busy.length - 1) * gapPx;
  const k = usable / total;
  const segs = [];
  let acc = x0;
  for (const [a, b] of busy) {
    segs.push({ a, b, x: acc, w: (b - a) * k });
    acc += (b - a) * k + gapPx;
  }
  const x = (ms) => {
    for (const seg of segs) {
      if (ms <= seg.a) return seg.x;
      if (ms <= seg.b) return seg.x + (ms - seg.a) * k;
    }
    const last = segs[segs.length - 1];
    return last.x + last.w;
  };
  // The inverse, so a dragged pixel range becomes a time range. Landing in a cut stretch
  // resolves to its nearer edge rather than to a moment that was never drawn.
  const inv = (px) => {
    for (const seg of segs) {
      if (px <= seg.x) return seg.a;
      if (px <= seg.x + seg.w) return seg.a + (px - seg.x) / k;
    }
    const last = segs[segs.length - 1];
    return last.b;
  };
  return { x, inv, segs, k, total };
}

// The window the timeline is drawn over, or null for the whole run. Set by dragging.
let zoom = null;
// The scale of the chart as last drawn, so the drag handler can turn pixels back into
// moments without rebuilding it.
let lastClock = null;

function timeline(d) {
  const agents = d.agents.filter((a) => Number.isFinite(a.started_at));
  if (!agents.length) return '<div class="sub2">' + tr("noTimed") + "</div>";
  const W = 1000,
    lane = 15,
    padL = 116,
    padT = 15,
    gapPx = 26;
  const H = padT + agents.length * lane + 16;
  const visible = zoom
    ? d.calls.filter((c) => c.at + c.charged_ms >= zoom.from && c.at <= zoom.to)
    : d.calls;
  const byAgent = new Map();
  for (const c of visible) {
    if (!byAgent.has(c.agent_id)) byAgent.set(c.agent_id, []);
    byAgent.get(c.agent_id).push(c);
  }
  // The clock is built from the CALLS, not from the agents' spans: an agent that idles for
  // an hour should not buy an hour of axis.
  const clock = compressedClock(
    visible.map((c) => [c.at, c.at + c.charged_ms]),
    padL,
    W - 8,
    gapPx,
  );
  if (!clock) return '<div class="sub2">' + tr("noTimed") + "</div>";
  const x = clock.x;

  let s = "";
  // Ticks at the start of each kept stretch, plus a marker for what was cut between them.
  clock.segs.forEach((seg, i) => {
    if (i) {
      const skipped = seg.a - clock.segs[i - 1].b;
      const mid = seg.x - gapPx / 2;
      s +=
        '<line x1="' +
        mid.toFixed(1) +
        '" x2="' +
        mid.toFixed(1) +
        '" y1="' +
        padT +
        '" y2="' +
        (H - 14) +
        '" stroke="var(--rule)" stroke-width="1" stroke-dasharray="2 3"/>';
      // Two cuts close together put two labels on the same pixels. Only label a cut with
      // room of its own, and drop the rest: the dashed rule already says one is there.
      const room =
        seg.x - (i > 1 ? clock.segs[i - 1].x + clock.segs[i - 1].w : 0);
      if (room > 74)
        s +=
          '<text x="' +
          mid.toFixed(1) +
          '" y="' +
          (H - 3) +
          '" text-anchor="middle" class="lab">' +
          esc(dur(skipped) + " " + tr("skipped")) +
          "</text>";
    }
    s +=
      '<text x="' +
      seg.x.toFixed(1) +
      '" y="' +
      (padT - 5) +
      '">' +
      esc(new Date(seg.a).toISOString().slice(11, 16)) +
      "</text>";
  });

  agents.forEach((a, i) => {
    const y = padT + i * lane;
    // The whole lane, under its calls, answers for the agent: hovering a call names the
    // call, hovering anything else on the lane names the agent and its figures.
    s +=
      '<rect class="lane" x="0" y="' +
      y +
      '" width="' +
      W +
      '" height="' +
      lane +
      '" data-tip="' +
      esc(agentName(a)) +
      '" data-tip2="' +
      esc(agentStats(a)) +
      '"/>';
    s +=
      '<text x="' +
      (padL - 6) +
      '" y="' +
      (y + 10) +
      '" text-anchor="end" pointer-events="none">' +
      esc((a.role || "?").slice(0, 14) + " " + a.agent_id.slice(-4)) +
      "</text>";
    const calls = byAgent.get(a.agent_id) || [];
    if (calls.length) {
      const from = Math.min(...calls.map((c) => c.at));
      const to = Math.max(...calls.map((c) => c.at + c.charged_ms));
      s +=
        '<line class="gl" pointer-events="none" x1="' +
        x(from).toFixed(1) +
        '" x2="' +
        x(to).toFixed(1) +
        '" y1="' +
        (y + 7) +
        '" y2="' +
        (y + 7) +
        '"/>';
    }
    for (const c of calls) {
      const x1 = x(c.at);
      const x2 = x(c.at + c.charged_ms);
      s +=
        '<rect class="seg" x="' +
        x1.toFixed(1) +
        '" y="' +
        (y + 2) +
        '" width="' +
        Math.max(1.5, x2 - x1).toFixed(1) +
        '" height="10" rx="1.5" fill="' +
        color(c.activity) +
        '" data-activity="' +
        esc(c.activity) +
        '" data-tip="' +
        esc(
          c.tool_short +
            " . " +
            actLabel(c.activity) +
            " . " +
            dur(c.charged_ms),
        ) +
        '" data-tip2="' +
        esc(
          (c.summary || "") +
            (c.detail ? "\n" + String(c.detail).slice(0, 300) : ""),
        ) +
        '"/>';
    }
  });
  // The scale is stashed so the drag handler can turn pixels back into moments without
  // rebuilding it, and so a zoom can be nested inside a zoom.
  lastClock = { clock, W, padL, padT, H };
  return (
    '<div class="tlwrap"><svg id="tlsvg" viewBox="0 0 ' +
    W +
    " " +
    H +
    '" role="img" aria-label="Agent timeline">' +
    s +
    '<rect id="tlbrush" x="0" y="0" width="0" height="0" fill="var(--accent)" ' +
    'opacity="0.18" pointer-events="none"/></svg>' +
    '<div class="tlbar"><span>' +
    (zoom
      ? esc(tr("zoomOn") + " " + dur(zoom.to - zoom.from))
      : esc(tr("dragToZoom"))) +
    "</span>" +
    (zoom
      ? '<button type="button" id="tlreset">' + esc(tr("reset")) + "</button>"
      : "") +
    "</div></div>"
  );
}

/* --- context growth, one line per agent --- */
function ctxChart(d) {
  const byAgent = new Map();
  for (const t of d.turns) {
    if (!byAgent.has(t.agent_id)) byAgent.set(t.agent_id, []);
    byAgent.get(t.agent_id).push(t);
  }
  const maxCtx = Math.max(...d.turns.map((t) => t.ctx), 1);
  const maxIdx = Math.max(...d.turns.map((t) => t.idx), 1);
  const W = 500,
    H = 150,
    p = { l: 34, r: 8, t: 8, b: 16 };
  const cx = (i) => p.l + (i / maxIdx) * (W - p.l - p.r);
  const cy = (v) => p.t + (1 - v / maxCtx) * (H - p.t - p.b);
  let s = "";
  for (let i = 0; i <= 3; i++) {
    const v = (maxCtx / 3) * i,
      yy = cy(v);
    s +=
      '<line class="gl" x1="' +
      p.l +
      '" x2="' +
      (W - p.r) +
      '" y1="' +
      yy.toFixed(1) +
      '" y2="' +
      yy.toFixed(1) +
      '"/>';
    s +=
      '<text x="' +
      (p.l - 4) +
      '" y="' +
      (yy + 3) +
      '" text-anchor="end">' +
      K(v) +
      "</text>";
  }
  const roleColor = new Map();
  let ci = 0;
  for (const [id, turns] of byAgent) {
    const a = d.agents.find((x) => x.agent_id === id);
    if (!a) continue;
    if (!roleColor.has(a.role))
      roleColor.set(
        a.role,
        "var(--" +
          ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"][ci++ % 8] +
          ")",
      );
    const stroke = roleColor.get(a.role);
    const points = turns
      .map((t) => cx(t.idx).toFixed(1) + "," + cy(t.ctx).toFixed(1))
      .join(" ");
    // A 1.6px line is too thin to hover, so a wide transparent copy over it takes the
    // pointer and names the agent.
    s +=
      '<g class="cline"><polyline points="' +
      points +
      '" fill="none" stroke="' +
      stroke +
      '" stroke-width="1.6" stroke-linejoin="round" opacity="0.85"/>' +
      '<polyline class="hit" points="' +
      points +
      '" fill="none" stroke="transparent" stroke-width="8" data-tip="' +
      esc(agentName(a)) +
      '" data-tip2="' +
      esc(agentStats(a)) +
      '"/></g>';
  }
  s += '<text x="' + p.l + '" y="' + (H - 3) + '">' + tr("turn") + " 0</text>";
  s +=
    '<text x="' +
    (W - p.r) +
    '" y="' +
    (H - 3) +
    '" text-anchor="end">' +
    tr("turn") +
    " " +
    maxIdx +
    "</text>";
  return (
    '<svg viewBox="0 0 ' +
    W +
    " " +
    H +
    '" role="img" aria-label="Context per turn">' +
    s +
    "</svg>" +
    '<div class="leg">' +
    [...roleColor]
      .map(
        ([role, c]) =>
          '<span><i class="dot" style="background:' +
          c +
          '"></i>' +
          esc(role) +
          "</span>",
      )
      .join("") +
    "</div>"
  );
}

/* --- composition: the run's minutes, split three ways --- */
function composition(work, wait, idle, supervise, human) {
  // Agent time: what its two parts add up to. Never the wall clock, and never a wait on a
  // child or on a human, which are somebody else's minutes.
  const total = work + wait || 1;
  const W = 500,
    H = 30;
  const parts = [
    { k: tr("toolWorkLabel"), v: work, fill: "var(--accent)" },
    { k: tr("genLabel"), v: wait, fill: "var(--s7)" },
  ];
  let x = 0,
    s = "";
  for (const p of parts) {
    const w = (p.v / total) * W;
    s +=
      '<rect class="seg" x="' +
      x.toFixed(1) +
      '" y="0" width="' +
      Math.max(0, w - 1.5).toFixed(1) +
      '" height="' +
      H +
      '" rx="2" fill="' +
      p.fill +
      '" data-tip="' +
      esc(p.k) +
      '" data-tip2="' +
      esc(dur(p.v) + " · " + pct(p.v, total) + "%") +
      '"/>';
    if (w > 92)
      s +=
        '<text class="v" x="' +
        (x + 8) +
        '" y="' +
        (H / 2 + 3) +
        '" style="fill:#fff">' +
        esc(p.k + "  " + pct(p.v, total) + "%") +
        "</text>";
    x += w;
  }
  return (
    '<svg viewBox="0 0 ' +
    W +
    " " +
    H +
    '" role="img">' +
    s +
    "</svg>" +
    '<div class="sub2">' +
    esc(
      dur(work) +
        " " +
        tr("acting") +
        " · " +
        dur(wait) +
        " " +
        tr("generating") +
        (supervise > 0
          ? " · " + dur(supervise) + " " + tr("superviseExcluded")
          : "") +
        (human > 0 ? " · " + dur(human) + " " + tr("humanExcluded") : "") +
        (idle > 0 ? " · " + dur(idle) + " " + tr("idleExcluded") : ""),
    ) +
    "</div>"
  );
}

/* --- render one run --- */
const sel = document.getElementById("pick");
sel.innerHTML = D.picked
  .map((id) => {
    const r = D.runs.find((x) => x.session_id === id) || {};
    return (
      '<option value="' +
      esc(id) +
      '">' +
      esc(
        day(r.started_at) +
          "  ·  " +
          // The name the session already has, which is how a reader recognises a run. The
          // project and the id stay, because two runs can share a title.
          (r.title || r.session_id.slice(0, 8)) +
          "  ·  " +
          (r.slug || "").replace(/^-workspaces-/, "") +
          "  ·  " +
          r.agent_count +
          " agents  ·  " +
          dur(r.active_ms),
      ) +
      "</option>"
    );
  })
  .join("");
sel.onchange = () => render(sel.value);

// The run being drawn. The drill-down keys on this and never on the select's value: reading
// the control made the table depend on the DOM agreeing with the data.
let currentRun = null;
// What the drawer is showing, so a redraw of the same run can show it again.
let drillSel = null;

function render(id) {
  const sameRun = currentRun === id;
  currentRun = id;
  const run = D.runs.find((x) => x.session_id === id);
  const d = D.detail[id];
  document.getElementById("h1").textContent = L.title[lang];
  // A redacted page must say so: its drill-downs are empty by design, not by accident.
  const flag = document.getElementById("redacted");
  if (flag) {
    flag.hidden = !D.redacted;
    flag.textContent = tr("redactedBadge");
  }
  // So must a cost priced at the fallback rate: it is a guess, and it reads like the rest.
  const unpriced = document.getElementById("unpriced");
  if (unpriced) {
    const models = (d && d.unpriced) || [];
    unpriced.hidden = run.rate_known !== 0 && !models.length;
    unpriced.textContent = models.length
      ? tr("unpricedBadge") + " " + models.join(", ")
      : d && d.pricedStale
        ? tr("pricedStale")
        : tr("unpricedBadge") + " " + tr("unpricedAny");
    unpriced.onclick = () => {
      const target = document.getElementById("models");
      if (target)
        target.scrollIntoView({ behavior: "smooth", block: "center" });
    };
  }
  document.getElementById("runsub").textContent =
    (run.title ? run.title + " · " : "") +
    id.slice(0, 8) +
    " · " +
    (run.window_start ? L.windowed[lang] : L.solo[lang]);

  const act = new Map(d.activities.map((a) => [a.activity, a]));
  // Own work only: a call that blocks on a child agent or on a human is somebody else's
  // time, and the child's own row already carries it.
  const workMs = d.activities
    .filter((a) => isOwnWork(a.activity))
    .reduce((s, a) => s + a.wall_ms, 0);
  const superviseMs = d.activities
    .filter((a) => a.activity === "dispatch")
    .reduce((s, a) => s + a.wall_ms, 0);
  const humanMs = d.activities
    .filter((a) => a.activity === "ask")
    .reduce((s, a) => s + a.wall_ms, 0);
  const waitMs = act.get("wait") ? act.get("wait").wall_ms : 0;
  const idleMs = act.get("idle") ? act.get("idle").wall_ms : 0;
  const calls = d.activities.reduce((s, a) => s + a.calls, 0);
  const errors = d.activities.reduce((s, a) => s + a.errors, 0);
  const stalled = d.activities.reduce((s, a) => s + (a.stalled || 0), 0);
  const turns = d.agents.reduce((s, a) => s + a.turns_in_window, 0);
  const thinkTurns = d.agents.reduce((s, a) => s + a.think_turns, 0);
  const ctxTotals = new Map();
  for (const c of d.context)
    ctxTotals.set(c.agent_id, (ctxTotals.get(c.agent_id) || 0) + c.bytes);
  const startCtx = [...ctxTotals.values()].sort((a, b) => a - b);
  const outTok = d.agents.reduce((s, a) => s + a.out_tokens, 0);
  const ctxs = d.turns.map((t) => t.ctx).sort((x, y) => x - y);
  const dd = d.durations;
  const ratio = workMs > 0 ? waitMs / workMs : 0;
  const wastedMs = d.loops.reduce((s, l) => s + (l.wasted_ms || 0), 0);

  const work = d.activities
    .filter((a) => isOwnWork(a.activity) && a.wall_ms > 0)
    .sort((a, b) => b.wall_ms - a.wall_ms);

  // The preamble every turn re-reads, and what that share of the bill is.
  // Measured from the billed context of each agent's first turn, times the turns that
  // re-read it. Summing the attachment breakdown instead understated a 2026-09-07 run
  // ninefold, because prompt_snapshot did not exist on that date.
  const preTokens = d.preamble.reduce(
    (sum, a) => sum + (a.tokens || 0) * a.turns,
    0,
  );
  const cov = d.contextCoverage || { known: 0, total: 0 };
  const rereadTokens = d.tokens ? d.tokens.reread || 0 : 0;
  const preShare = rereadTokens > 0 ? preTokens / rereadTokens : 0;
  const busyMs = run.busy_ms || 0;
  const windowMs = run.window_ms || run.active_ms || 1;
  const coordMs = run.coord_ms || 0;
  const stallMs = run.stall_ms || 0;
  // A run is a session, and a session can be resumed days later: its end-to-end span is
  // then six days of which four hours were work. Every time share is taken against the
  // WORKING envelope (busy plus the short turnarounds), which a resume cannot inflate. The
  // span stays on the page as its own figure, with its own caveat.
  const workingMs = busyMs + coordMs;
  // The host session is not a pipeline agent and it spans the whole conversation: leaving
  // it in made "longest agent" report the main thread on every run.
  const longest = d.agents
    .filter((a) => a.agent_id !== "main" && a.turns_in_window > 0)
    .reduce(
      (best, a) => (!best || a.active_ms > best.active_ms ? a : best),
      null,
    );
  const agentMs = workMs + waitMs;
  // Against BUSY time, not the window: dividing by a window that is half dead time reports
  // a parallelism the run never had.
  const par = busyMs > 0 ? agentMs / busyMs : 0;
  const P = [];

  /* --- 1. what it cost, and how long it took ----------------------------------- */
  // One heading, the cost tiles on one row and the clock tiles on the row under it: they
  // are read together, and the panels sit below both rather than between them.
  P.push(section(tr("sSummary")));
  const costTiles = [];
  const timeTiles = [];
  costTiles.push(
    tileK(
      "cost",
      usd(run.usd),
      tr("inWindow") +
        (run.host_usd
          ? " · " + usd(run.host_usd) + " " + tr("outsideShort")
          : ""),
    ),
  );
  costTiles.push(
    tileK(
      "perTurn",
      usd(turns ? run.usd / turns : 0),
      turns + " " + tr("hTurns"),
    ),
  );
  costTiles.push(
    tileK(
      "preambleTax",
      Math.round(preShare * 100) + "<small>%</small>",
      tr("ofReread") + " · " + usd(run.usd * preShare),
      preShare >= 0.2 ? "flag" : "",
    ),
  );
  costTiles.push(
    tileK(
      "ctxBefore",
      startCtx.length ? kb(quantile(startCtx, 0.5)) : "-",
      startCtx.length
        ? tr("medianAgent") + " · " + tok(quantile(startCtx, 0.5))
        : tr("notRecorded"),
    ),
  );
  costTiles.push(
    tileK(
      "largestCtx",
      K(Math.max(...ctxs, 0)) + "<small> tok</small>",
      tr("medianTurn") + " " + K(quantile(ctxs, 0.5)),
    ),
  );
  if (run.host_turns)
    costTiles.push(
      tileK(
        "outside",
        usd(run.host_usd),
        run.host_turns + " " + tr("hostTurns"),
        "off",
      ),
    );
  timeTiles.push(
    tileK(
      "working",
      dur(workingMs),
      day(run.started_at) + " · " + run.agent_count + " " + tr("agents"),
    ),
  );
  timeTiles.push(tileK("wallClock", dur(windowMs), tr("endToEnd"), "off"));
  timeTiles.push(
    tileK(
      "busy",
      dur(busyMs),
      pct(busyMs, workingMs) + tr("ofWorking") + " · " + tr("atLeastOne"),
    ),
  );
  timeTiles.push(
    tileK(
      "coordination",
      dur(coordMs),
      pct(coordMs, workingMs) + tr("ofWorking") + " · " + tr("betweenAgents"),
    ),
  );
  timeTiles.push(
    tileK(
      "stalls",
      dur(stallMs),
      (run.stall_count || 0) + " " + tr("incidents"),
      (run.stall_count || 0) > 2 ? "flag" : "",
    ),
  );
  timeTiles.push(
    tileK(
      "parallel",
      par.toFixed(1) + "<small>x</small>",
      dur(agentMs) + " / " + dur(busyMs),
    ),
  );
  P.push('<div class="tiles">' + costTiles.join("") + "</div>");
  P.push('<div class="tiles">' + timeTiles.join("") + "</div>");
  P.push(panelK("pModels", modelsTable(d), "c3"));
  P.push(panelK("pTokens", tokenKinds(d), "c3"));
  P.push(panelK("pPreamble", preambleTable(d), "c3"));
  if (cov.total && cov.known < cov.total)
    P.push(
      panel(
        ttl("pCoverage"),
        '<div class="big sm">' +
          cov.known +
          " / " +
          cov.total +
          "</div>" +
          '<div class="sub2">' +
          esc(tr("compositionKnown")) +
          "</div>",
        "off",
        tipOf("pCoverage"),
      ),
    );
  P.push(panelK("pCtxFill", startingContext(d), "c3"));
  P.push(panelK("pCtxGrowth", ctxChart(d), "c3"));
  if (d.stalls.length)
    P.push(
      panelK(
        "pStalls",
        topTable(
          [tr("hWhen"), tr("hHowLong"), tr("hLastBefore")],
          d.stalls.map((g) => [
            '<span class="mono">' +
              esc(new Date(g.at).toISOString().slice(11, 19)) +
              "</span>",
            dur(g.ms),
            g.before
              ? esc((g.before.role || "?") + " · " + g.before.tool_short) +
                (g.hooks.length
                  ? ' <span class="tag">' + g.hooks.length + " hooks</span>"
                  : "")
              : "—",
          ]),
          (cells, i) =>
            ' class="seg" data-stall="' +
            i +
            '" data-tip="' +
            esc(dur(d.stalls[i].ms) + " · " + tr("clickForWhy")) +
            '" data-tip2="' +
            esc(
              d.stalls[i].hooks.length ? tr("hasHookTrace") : tr("noHookTrace"),
            ) +
            '"',
        ),
        "c4",
      ),
    );
  P.push(
    panelK(
      "pComposition",
      composition(workMs, waitMs, idleMs, superviseMs, humanMs),
      "c4",
    ),
  );

  /* --- 3. what they did ---------------------------------------------------------- */
  P.push(section(tr("sWork")));
  P.push(
    tileK("toolWork", dur(workMs), pct(workMs, agentMs) + tr("ofAgentTime")),
  );
  P.push(
    tileK(
      "waiting",
      dur(waitMs),
      pct(waitMs, agentMs) + tr("ofAgentTime"),
      ratio >= 1.5 ? "flag" : "",
    ),
  );
  P.push(
    tileK(
      "ratio",
      ratio.toFixed(1) + "<small>x</small>",
      ratio >= 1.5 ? tr("waitsMore") : tr("actsMore"),
      ratio >= 1.5 ? "flag" : "",
    ),
  );
  P.push(tileK("supervise", dur(superviseMs), tr("blockedOnChildren"), "off"));
  if (humanMs > 0)
    P.push(tileK("human", dur(humanMs), tr("blockedOnHuman"), "off"));
  const hk = d.hookTotal || { runs: 0, ms: 0 };
  P.push(
    tileK(
      "hookTime",
      dur(hk.ms || 0),
      (hk.runs || 0) +
        " " +
        tr("hookRuns") +
        (d.hooks.some((h) => h.blocks) ? "" : " · " + tr("noSubagentStop")),
      "off",
    ),
  );
  P.push(tileK("idle", dur(idleMs), tr("openNotWorking"), "off"));
  P.push(
    panelK(
      "pByActivity",
      donut(
        work.map((a) => ({
          k: actLabel(a.activity),
          v: a.wall_ms,
          fill: color(a.activity),
          def: actDef(a.activity),
          // Every slice opens onto the calls behind it, a skill onto the skills it loaded.
          attr: ' data-activity="' + esc(a.activity) + '"',
        })),
        workMs || 1,
        dur,
      ),
      "c2",
    ),
  );
  P.push(panelK("pHistogram", histogram(dd, ttl("pHistogram")), "c2"));
  // Their duration is the child's or the human's, so they rank apart from the tools the
  // agent actually ran: sorted by time they sat on top for the wrong reason.
  const ownTools = d.tools.filter((t) => !BLOCKING_TOOLS.has(t.tool_short));
  const blockingTools = d.tools.filter((t) => BLOCKING_TOOLS.has(t.tool_short));
  if (blockingTools.length)
    P.push(
      panelK(
        "pDispatches",
        topTable(
          [tr("hTool"), tr("hN"), tr("hTime")],
          blockingTools.map((t) => [
            '<span class="mono">' + esc(t.tool_short) + "</span>",
            t.n,
            dur(t.ms),
          ]),
          (cells, i) =>
            ' class="seg" data-tool="' + esc(blockingTools[i].tool_short) + '"',
        ),
        "c2",
      ),
    );
  P.push(
    panelK(
      "pTools",
      topTable(
        [tr("hTool"), tr("hN"), tr("hTime"), tr("hErr")],
        ownTools.map((t) => [
          '<span class="mono">' + esc(t.tool_short) + "</span>",
          t.n,
          dur(t.ms),
          t.err ? '<span class="tag bad">' + t.err + "</span>" : "",
        ]),
        (cells, i) =>
          ' class="seg" data-tool="' +
          esc(ownTools[i].tool_short) +
          '" data-tip="' +
          esc(ownTools[i].tool_short + " · " + tr("clickForCalls")) +
          '" data-tip2="' +
          esc(
            ownTools[i].n + " " + tr("callsWord") + " · " + dur(ownTools[i].ms),
          ) +
          '"',
      ),
      "c4",
    ),
  );
  P.push(
    panelK(
      "pTimeline",
      timeline(d),
      "full",
      " · " + d.calls.length + " " + tr("longestCalls"),
    ),
  );

  /* --- 4. waste ------------------------------------------------------------------ */
  P.push(section(tr("sWaste")));
  P.push(
    tileK(
      "errorRate",
      (calls ? Math.round((errors / calls) * 100) : 0) + "<small>%</small>",
      errors + " / " + calls + " " + tr("ofCalls"),
      calls && errors / calls > 0.05 ? "flag" : "",
    ),
  );
  P.push(
    tileK(
      "repeated",
      dur(wastedMs),
      d.loops.length
        ? d.loops.length + " " + tr("repeatsFound")
        : tr("noneFound"),
      wastedMs > 60000 ? "flag" : "",
    ),
  );
  P.push(tileK("turns", K(turns), thinkTurns + " " + tr("noToolCall")));
  P.push(
    tileK(
      "calls",
      K(calls),
      errors +
        " " +
        tr("errored") +
        (stalled ? " · " + stalled + " " + tr("stalledN") : ""),
    ),
  );
  P.push(
    panelK(
      "pErrors",
      topTable(
        [tr("hTool"), tr("hN"), tr("hErr")],
        d.errorsByTool.map((e) => [
          '<span class="mono">' + esc(e.tool_short) + "</span>",
          e.n,
          '<span class="tag bad">' +
            e.err +
            " · " +
            Math.round((e.err / e.n) * 100) +
            "%</span>",
        ]),
        (cells, i) =>
          ' class="seg" data-tool="' + esc(d.errorsByTool[i].tool_short) + '"',
      ),
      "c3",
    ),
  );
  P.push(
    panelK(
      "pLoops",
      topTable(
        [tr("hWhat"), tr("hKind"), tr("hTimes"), tr("hWasted")],
        d.loops.map((l) => [
          '<span class="mono">' + esc(l.detail || l.tool || "") + "</span>",
          esc(l.kind),
          l.count,
          dur(l.wasted_ms),
        ]),
      ),
      "c3",
    ),
  );
  // A dispatch lasts as long as its child and a question as long as the human: neither is a
  // slow tool, and both would top this table for that reason alone.
  const longCalls = d.calls
    .filter((c) => !BLOCKED.has(c.activity))
    .slice(0, 10);
  P.push(
    panelK(
      "pLongest",
      topTable(
        [tr("hToolArg"), tr("hActivity"), tr("hTook")],
        longCalls.map((c) => [
          '<span class="mono">' +
            esc(c.tool_short) +
            "</span> " +
            '<span style="color:var(--muted)">' +
            esc(c.summary || "") +
            "</span>",
          '<i class="dot" style="background:' +
            color(c.activity) +
            '"></i> ' +
            esc(actLabel(c.activity)),
          dur(c.charged_ms) +
            (c.stalled ? ' <span class="tag bad">stalled</span>' : "") +
            (c.is_error ? ' <span class="tag bad">err</span>' : ""),
        ]),
        (cells, i) =>
          ' data-tip="' +
          esc(
            longCalls[i].tool_short +
              " · " +
              actLabel(longCalls[i].activity) +
              " · " +
              dur(longCalls[i].charged_ms) +
              (longCalls[i].stalled ? " · stalled" : ""),
          ) +
          '" data-tip2="' +
          esc(
            (longCalls[i].detail || "").slice(0, 420) +
              (longCalls[i].stalled ? "  —  " + tr("stalledWhat") : ""),
          ) +
          '"',
      ),
      "c3",
    ),
  );

  /* --- 5. per role --------------------------------------------------------------- */
  P.push(section(tr("sRoles")));
  P.push(
    panelK(
      "pCostRole",
      donut(
        d.roles.map((r, i) => ({
          k: r.role,
          v: r.usd,
          fill:
            "var(--" +
            ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"][i % 8] +
            ")",
        })),
        d.roles.reduce((s, r) => s + r.usd, 0) || 1,
        usd,
      ),
      "c2",
    ),
  );
  P.push(
    panelK(
      "pWaitAfter",
      topTable(
        [tr("hAfter"), tr("hTurns"), tr("hGen"), tr("hAvgOut")],
        // After a dispatch or a question, the gap is the model reading another agent's or a
        // person's answer: the timeline already shows that wait, and no tool caused it.
        d.waitAfter
          .filter((w) => !BLOCKED.has(w.prev))
          .slice(0, 8)
          .map((w) => [
            '<i class="dot" style="background:' +
              color(w.prev) +
              '"></i> ' +
              esc(actLabel(w.prev)),
            w.turns,
            dur(w.wait_ms),
            K(w.avg_out),
          ]),
      ),
      "c3",
    ),
  );
  P.push(
    panelK(
      "pFiles",
      topTable(
        [tr("hFile"), tr("hTimes")],
        d.files.map((f) => [
          '<span class="mono">' +
            esc(f.path.split("/").slice(-3).join("/")) +
            "</span>",
          f.n,
        ]),
      ),
      "c3",
    ),
  );
  if (d.hooks.length)
    P.push(
      panelK(
        "pHooks",
        topTable(
          [tr("hHook"), tr("hRuns"), tr("hTime"), tr("hNonZero")],
          d.hooks.map((h) => [
            esc(h.hook),
            h.runs,
            dur(h.ms),
            h.failures
              ? '<span class="tag bad">' + h.failures + "</span>"
              : "0",
          ]),
        ),
        "c3",
      ),
    );

  document.getElementById("grid").innerHTML = P.join("");
  wireTimeline();
  // A language switch or a zoom redraws the same run: what was open stays open.
  drill(sameRun ? drillSel : null);
}

for (const b of document.getElementById("langs").children) {
  b.setAttribute("aria-pressed", String(Number(b.dataset.lang) === lang));
  b.addEventListener("click", () => {
    lang = Number(b.dataset.lang);
    try {
      localStorage.setItem("runAnatomyLang", lang ? "fr" : "en");
    } catch {
      /* the choice still applies to this view, it just will not be remembered */
    }
    for (const o of document.getElementById("langs").children)
      o.setAttribute("aria-pressed", String(Number(o.dataset.lang) === lang));
    hideTip();
    render(sel.value);
  });
}

try {
  render(D.picked[0]);
} catch (err) {
  const boom = document.getElementById("boom");
  boom.hidden = false;
  boom.innerHTML =
    '<div class="p" style="border-color:var(--danger)"><h2>' +
    L.boom[lang] +
    "</h2>" +
    '<div class="mono">' +
    esc(err && err.message) +
    "</div></div>";
  throw err;
}

/* --- drill-down: what is behind a bar ---
   An aggregate that cannot be opened is a number to be taken on faith. Clicking a tool row,
   an activity, a model or a band in the timeline lists what makes it up, with the full
   command on hover rather than truncated into uselessness. It opens in a drawer over the
   right edge, so the figure that was clicked stays in view beside its detail. */
function drill(sel) {
  const drawer = document.getElementById("drawer");
  const host = document.getElementById("drill");
  if (!drawer || !host) return;
  const d = D.detail[currentRun];
  const wasOpen = drawer.classList.contains("open");
  const html = d && sel ? drillBody(d, sel) : "";
  drillSel = html ? sel : null;
  if (!html) {
    drawer.classList.remove("open");
    drawer.setAttribute("aria-hidden", "true");
    return;
  }
  host.innerHTML = html;
  drawer.scrollTop = 0;
  drawer.classList.add("open");
  drawer.setAttribute("aria-hidden", "false");
  const clear = document.getElementById("drillClear");
  if (clear) {
    clear.addEventListener("click", () => drill(null));
    if (!wasOpen) clear.focus({ preventScroll: true });
  }
}

function drillBody(d, sel) {
  if (sel.stall !== undefined) return drillStall(d.stalls[sel.stall]);
  if (sel.ctx) return drillContext(d, sel.ctx, sel.role);
  if (sel.model) return drillModel(d, sel.model);
  if (sel.activity) return drillActivity(d, sel.activity);
  if (sel.tool) {
    const rows = d.calls.filter((c) => c.tool_short === sel.tool);
    return (
      drillHead(sel.tool, callsMeta(rows)) +
      '<h4 class="dsub">' +
      esc(tr("dCalls")) +
      "</h4>" +
      callsTable(rows)
    );
  }
  return "";
}

const drillHead = (title, meta) =>
  '<div class="drillhead"><b>' +
  esc(title) +
  "</b>" +
  (meta ? "<span>" + esc(meta) + "</span>" : "") +
  ' <button type="button" id="drillClear" aria-label="' +
  esc(tr("close")) +
  '">×</button></div>';

const callsMeta = (rows) =>
  rows.length +
  " " +
  tr("callsWord") +
  " · " +
  dur(rows.reduce((s, c) => s + c.charged_ms, 0));

/** One row per call, longest first, the full command one hover away. */
function callsTable(rows) {
  return topTable(
    [tr("hTool"), tr("hActivity"), tr("hTook"), tr("hWhat")],
    rows
      .slice(0, 60)
      .map((c) => [
        '<span class="mono">' + esc(c.tool_short) + "</span>",
        '<i class="dot" style="background:' +
          color(c.activity) +
          '"></i> ' +
          esc(actLabel(c.activity)),
        dur(c.charged_ms) +
          (c.stalled ? ' <span class="tag bad">stalled</span>' : "") +
          (c.is_error ? ' <span class="tag bad">err</span>' : ""),
        '<span class="mono">' + esc(c.summary || "") + "</span>",
      ]),
    (cells, i) =>
      ' data-tip="' +
      esc(rows[i].tool_short + " · " + dur(rows[i].charged_ms)) +
      '" data-tip2="' +
      esc((rows[i].detail || "").slice(0, 400)) +
      '"',
  );
}

/**
 * What one activity is made of: its definition, then its calls grouped by tool, then the
 * calls themselves. A skill is grouped by the skill it loaded, since every one of those
 * calls is the same tool.
 */
function drillActivity(d, activity) {
  const rows = d.calls.filter((c) => c.activity === activity);
  const bySkill = activity === "skill";
  const groups = new Map();
  for (const c of rows) {
    const k = bySkill ? c.summary || c.tool_short : c.tool_short;
    const g = groups.get(k) || { k, n: 0, ms: 0 };
    g.n++;
    g.ms += c.charged_ms;
    groups.set(k, g);
  }
  const list = [...groups.values()].sort((a, b) => b.ms - a.ms || b.n - a.n);
  return (
    drillHead(actLabel(activity), callsMeta(rows)) +
    (actDef(activity)
      ? '<p class="def">' + esc(actDef(activity)) + "</p>"
      : "") +
    (bySkill || list.length > 1
      ? '<h4 class="dsub">' +
        esc(bySkill ? tr("dBySkill") : tr("dByTool")) +
        "</h4>" +
        topTable(
          [bySkill ? tr("hSkill") : tr("hTool"), tr("hN"), tr("hTime")],
          list.map((g) => [
            '<span class="mono">' + esc(g.k) + "</span>",
            g.n,
            dur(g.ms),
          ]),
          bySkill
            ? ""
            : (cells, i) => ' class="seg" data-tool="' + esc(list[i].k) + '"',
        )
      : "") +
    '<h4 class="dsub">' +
    esc(tr("dCalls")) +
    "</h4>" +
    callsTable(rows)
  );
}

/** The agents that ran one model, and what each spent on it. */
function drillModel(d, model) {
  const rows = (d.models || [])
    .filter((r) => r.model === model)
    .sort((a, b) => (b.usd || 0) - (a.usd || 0));
  const m = modelRows(d).find((r) => r.model === model);
  if (!m) return "";
  return (
    drillHead(
      model,
      usd(m.usd) + " · " + K(m.tokens) + " tok · " + dur(m.gen),
    ) +
    '<h4 class="dsub">' +
    esc(tr("dAgents")) +
    "</h4>" +
    topTable(
      [tr("hAgent"), tr("hTurns"), "$", tr("hTokens"), tr("hGen")],
      rows.map((r) => [
        '<span class="mono">' +
          esc(agentName(d.agents.find((a) => a.agent_id === r.agent_id))) +
          "</span>",
        r.turns,
        usd(r.usd),
        K(r.tokens),
        dur(r.gen_ms),
      ]),
    )
  );
}

document.addEventListener("click", (e) => {
  let el = e.target;
  while (el && el !== document) {
    if (el.dataset && el.dataset.ctx)
      return drill({ ctx: el.dataset.ctx, role: el.dataset.ctxRole || null });
    if (el.dataset && el.dataset.stall !== undefined)
      return drill({ stall: Number(el.dataset.stall) });
    if (el.dataset && el.dataset.model)
      return drill({ model: el.dataset.model });
    if (el.dataset && el.dataset.tool) return drill({ tool: el.dataset.tool });
    if (el.dataset && el.dataset.activity)
      return drill({ activity: el.dataset.activity });
    // Inside the drawer, or on the page's own controls: nothing to close.
    if (el.id === "drawer" || el.classList?.contains("bar")) return;
    el = el.parentNode;
  }
  if (drillSel) drill(null);
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && drillSel) drill(null);
});

/* --- drag a range on the timeline to zoom into it ---
   A run can spread 25 agents over three hours; the interesting minute is then two pixels
   wide. Dragging selects a range, and the chart is rebuilt over it. */
function wireTimeline() {
  const svg = document.getElementById("tlsvg");
  if (!svg || !lastClock) return;
  const reset = document.getElementById("tlreset");
  if (reset)
    reset.addEventListener("click", () => {
      zoom = null;
      render(currentRun);
    });

  const brush = document.getElementById("tlbrush");
  const { clock, W, padT, H } = lastClock;
  let from = null;
  const toUser = (e) => {
    const box = svg.getBoundingClientRect();
    return ((e.clientX - box.left) / box.width) * W;
  };
  svg.addEventListener("mousedown", (e) => {
    from = toUser(e);
    brush.setAttribute("y", String(padT));
    brush.setAttribute("height", String(H - padT - 14));
    e.preventDefault();
  });
  svg.addEventListener("mousemove", (e) => {
    if (from === null) return;
    const now = toUser(e);
    brush.setAttribute("x", String(Math.min(from, now)));
    brush.setAttribute("width", String(Math.abs(now - from)));
  });
  const finish = (e) => {
    if (from === null) return;
    const now = toUser(e);
    const a = Math.min(from, now);
    const b = Math.max(from, now);
    from = null;
    brush.setAttribute("width", "0");
    // A click is not a drag: under a few pixels there is no range to zoom into.
    if (b - a < 6) return;
    zoom = { from: clock.inv(a), to: clock.inv(b) };
    render(currentRun);
  };
  svg.addEventListener("mouseup", finish);
  svg.addEventListener("mouseleave", finish);
}

/**
 * What happened around a stall.
 *
 * A stall reported as a duration is a question, not an answer. This shows the call that ran
 * last before the silence, the one that ran first after it, and every hooks.log line in
 * between, which is the only evidence that a SubagentStop hook, and therefore the
 * validation chain, was what filled it.
 */
function drillStall(g) {
  if (!g) return "";
  const when = (ms) => new Date(ms).toISOString().slice(11, 19);
  const side = (c, label) =>
    '<div class="stallside"><b>' +
    esc(label) +
    "</b>" +
    (c
      ? '<span class="mono">' +
        esc((c.role || "?") + " · " + c.tool_short) +
        "</span>" +
        '<span class="sub2 mono">' +
        esc(c.summary || (c.detail || "").slice(0, 160)) +
        "</span>" +
        '<span class="sub2">' +
        esc(when(c.at)) +
        "</span>"
      : '<span class="sub2">—</span>') +
    "</div>";

  return (
    drillHead(tr("stallAt") + " " + when(g.at), dur(g.ms)) +
    '<div class="stallgrid">' +
    side(g.before, tr("lastBefore")) +
    side(g.after, tr("firstAfter")) +
    "</div>" +
    (g.hooks.length
      ? topTable(
          [tr("hWhen"), tr("hHook"), tr("hWhat")],
          g.hooks.map((h) => [
            '<span class="mono">' + esc(when(h.at)) + "</span>",
            esc(h.hook),
            '<span class="mono">' + esc(h.message) + "</span>",
          ]),
        )
      : '<div class="sub2">' + esc(tr("noHookTrace")) + "</div>")
  );
}

/**
 * What is inside one part of a fresh context.
 *
 * The bar says an agent starts with 51 KB of tool definitions. That is a number. Which
 * tools, and how much each one takes, is a decision: an MCP server nobody uses costs the
 * same on every turn of every agent. Only the parts the transcript itemises can be opened —
 * tools, the skill inventory and the injected files — and the rest says so rather than
 * showing an empty table.
 */
const CTX_PREFIX = { tools: "tool:", skills: "skill:", instructions: "file:" };

function drillContext(d, component, role) {
  const prefix = CTX_PREFIX[component];
  // Filtered to the role whose bar was clicked. Without it the list contradicted the bar:
  // a planner's 12 KB of tools opened onto the 125 KB union of every role's.
  let items = prefix
    ? (d.contextItems || []).filter(
        (i) => i.component.startsWith(prefix) && (!role || i.role === role),
      )
    : [];
  // The legend carries no role, so it opens onto the union. The rows are per role, so the
  // union has to be deduplicated or the same tool is counted once per role that holds it.
  if (!role && items.length) {
    const byName = new Map();
    for (const i of items) {
      const prev = byName.get(i.component);
      if (!prev || (i.bytes || 0) > (prev.bytes || 0))
        byName.set(i.component, i);
    }
    items = [...byName.values()].sort(
      (a, b) => (b.bytes || 0) - (a.bytes || 0),
    );
  }
  const total = items.reduce((sum, i) => sum + (i.bytes || 0), 0);
  const sized = items.some((i) => i.bytes > 0);

  return (
    drillHead(
      (role ? role + " · " : "") + ctxLabel(component),
      items.length + " " + tr("hItem") + (sized ? " · " + kb(total) : ""),
    ) +
    (!prefix
      ? '<div class="sub2">' + esc(tr("noBreakdown")) + "</div>"
      : !items.length
        ? '<div class="sub2">' + esc(tr("noBreakdown")) + "</div>"
        : (sized
            ? ""
            : '<div class="sub2">' + esc(tr("inventoryOnly")) + "</div>") +
          topTable(
            sized ? [tr("hItem"), tr("hSize"), tr("hWhat")] : [tr("hItem")],
            items.map((i) =>
              sized
                ? [
                    '<span class="mono">' +
                      esc(i.component.slice(prefix.length)) +
                      "</span>",
                    kb(i.bytes),
                    '<span class="sub2">' + esc(i.detail || "") + "</span>",
                  ]
                : [
                    '<span class="mono">' +
                      esc(i.component.slice(prefix.length)) +
                      "</span>",
                  ],
            ),
          ))
  );
}
