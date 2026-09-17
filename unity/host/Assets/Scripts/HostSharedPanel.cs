using System;
using UnityEngine;
using BrainsAndBacchanal.Protocol;

namespace BrainsAndBacchanal
{
    /// <summary>
    /// ========= DEVELOPMENT SHARED-SYSTEMS TEST PANEL — NOT FINAL GAMEPLAY =========
    ///
    /// Phase 6 spec §44: "Extend Unity only enough to test shared systems. Keep it
    /// functional, not polished... Clearly mark DEV/TEST controls. Do not build
    /// final Market/Maco/Bacchanal presentation yet."
    ///
    /// So this is a test instrument: deal cards, open and close a card window,
    /// open and close the Market, draw Maco Mail, offer a Host Deal, resolve a
    /// wager, and WATCH what the server says happened. Phase 8 builds the real
    /// Host presentation — the Clash animation, the Market screen, the Maco Mail
    /// envelope — and none of this survives that.
    ///
    /// AND IT DECIDES NOTHING. Every button sends an intent and redraws whatever
    /// the server reports afterwards. No eligibility check, no price, no Clash
    /// outcome and no BB arithmetic lives in this file. A card's legality is the
    /// server's (spec §7, §41); this panel could not compute one if it tried,
    /// because it does not receive the table.
    /// =============================================================================
    /// </summary>
    public partial class HostLobby
    {
        // --- Test-panel input state ----------------------------------------
        private string _devChallengeKind = CardChallengeKinds.ThinkFast;
        private string _devMarketRound = "2";
        private string _devDealTemplate = HostDealTemplates.KeepOrRisk;
        private string _devSharedTeamId = TeamIds.A;
        private Vector2 _devSharedScroll;

        /// <summary>
        /// Challenge kinds this panel offers, as a FIXED array.
        ///
        /// Fixed so the Layout and Repaint passes of one OnGUI call always draw
        /// the same number of buttons — the discipline the other panels document.
        /// These are the rows of the locked compatibility table
        /// (GAME_RULES_LOCKED.md §6); the SERVER decides what each allows.
        /// </summary>
        private static readonly string[] ChallengeKindButtons =
        {
            CardChallengeKinds.Round1Trivia,
            CardChallengeKinds.ThinkFast,
            CardChallengeKinds.Round2Physical,
            CardChallengeKinds.FamilyFeudQ1Q3,
        };

        /// <summary>The four locked Host Deal templates. Spec §37/§38.</summary>
        private static readonly string[] DealTemplateButtons =
        {
            HostDealTemplates.KeepOrRisk,
            HostDealTemplates.DoubleOrNothingIsh,
            HostDealTemplates.MysteryDeal,
            HostDealTemplates.OpponentsDeal,
        };

        /// <summary>
        /// Draw the shared-systems test panel.
        ///
        /// The snapshot is passed in, already captured once by OnGUI, so every
        /// draw call in this pass sees identical values.
        /// </summary>
        private void DrawSharedPanel(LobbySnapshot snapshot, HostGameSnapshot game)
        {
            GUILayout.BeginVertical(GUILayout.Width(400));

            GUILayout.Label("SHARED SYSTEMS  [DEV]", HeaderStyle);

            if (game == null || !game.GameRunning)
            {
                GUILayout.Label("No game running.");
                GUILayout.EndVertical();
                return;
            }

            var shared = game.shared;
            if (shared == null)
            {
                GUILayout.Label("No shared-system state yet.");
                GUILayout.EndVertical();
                return;
            }

            _devSharedScroll = GUILayout.BeginScrollView(_devSharedScroll, GUILayout.Height(560));

            DrawCardStatus(shared);
            GUILayout.Space(6);
            DrawCardControls(shared, game.devToolsEnabled);
            GUILayout.Space(8);
            DrawClashStatus(shared);
            GUILayout.Space(8);
            DrawMarketControls(shared);
            GUILayout.Space(8);
            DrawMacoControls(snapshot, shared);
            GUILayout.Space(8);
            DrawDealControls(snapshot, shared);
            GUILayout.Space(8);
            DrawWagerControls(shared);

            GUILayout.EndScrollView();
            GUILayout.EndVertical();
        }

        private void DrawCardStatus(HostSharedView shared)
        {
            var window = shared.cardWindow;
            if (window == null)
            {
                GUILayout.Label("Card window: none");
                return;
            }

            GUILayout.Label(window.open
                ? $"Card window: OPEN ({window.challengeKind})"
                : "Card window: closed");

            var played = window.teamsWhoPlayed ?? Array.Empty<string>();
            if (played.Length > 0)
            {
                // GAME_RULES_LOCKED.md §2 — one card per team per challenge. The
                // Host needs to see who has already spent theirs.
                GUILayout.Label($"Played this challenge: {string.Join(", ", played)}");
            }
        }

        private void DrawCardControls(HostSharedView shared, bool devToolsEnabled)
        {
            GUILayout.Label("BACCHANAL", SubHeaderStyle);

            GUI.enabled = !_busy;
            if (GUILayout.Button("DEAL STARTING HANDS"))
            {
                _ = SubmitGameIntentAsync(SharedIntents.DealBacchanalCards, "{}");
            }

            // DEV ONLY. A real deal happens exactly once (GAME_RULES_LOCKED.md
            // §2); this exists so testing the Clash does not mean recreating the
            // whole room until a random deal happens to leave both teams holding
            // something playable for the challenge kind under test. The server
            // refuses this outright when devTools is off, same as the BB
            // controls in the engine panel — hidden here for the same reason
            // those are: no point offering a button that only bounces.
            if (devToolsEnabled)
            {
                var previousColor = GUI.color;
                GUI.color = Color.yellow;
                if (GUILayout.Button("[DEV] RE-DEAL STARTING HANDS"))
                {
                    _ = SubmitGameIntentAsync(SharedIntents.DevRedealBacchanalCards, "{}");
                }
                GUI.color = previousColor;
            }

            GUILayout.Label($"Open window as: {_devChallengeKind}");

            // A fixed set of buttons, one per offered challenge kind.
            GUILayout.BeginHorizontal();
            foreach (var kind in ChallengeKindButtons)
            {
                var selected = _devChallengeKind == kind;
                var previous = GUI.color;
                if (selected) GUI.color = Color.cyan;
                // Shortened for the button face only; the full identifier is
                // what travels on the wire.
                if (GUILayout.Button(ShortKind(kind), GUILayout.Width(88)))
                {
                    _devChallengeKind = kind;
                }
                GUI.color = previous;
            }
            GUILayout.EndHorizontal();

            GUILayout.BeginHorizontal();
            if (GUILayout.Button("OPEN CARD WINDOW"))
            {
                _ = SubmitGameIntentAsync(
                    SharedIntents.OpenCardWindow,
                    $"{{\"challengeKind\":\"{_devChallengeKind}\"}}");
            }
            if (GUILayout.Button("CLOSE"))
            {
                _ = SubmitGameIntentAsync(SharedIntents.CloseCardWindow, "{}");
            }
            GUILayout.EndHorizontal();
            GUI.enabled = true;
        }

        /// <summary>
        /// The Clash, as the Host may see it.
        ///
        /// NOTE WHAT IS NOT DRAWN while the window is open: the responders'
        /// cards. The server does not send them (spec §42), so there is nothing
        /// here to accidentally render onto a TV the players can see.
        /// </summary>
        private void DrawClashStatus(HostSharedView shared)
        {
            var clash = shared.clash;
            if (clash == null || string.IsNullOrEmpty(clash.clashId))
            {
                GUILayout.Label("Clash: none");
                return;
            }

            if (!clash.resolved)
            {
                var previous = GUI.color;
                GUI.color = Color.yellow;
                GUILayout.Label($"CLASH OPEN — {clash.initiatingTeamId} played {clash.initiatingCardType}");
                GUILayout.Label($"Window: {clash.remainingMs} ms");
                var responded = clash.respondedTeamIds ?? Array.Empty<string>();
                // WHO responded, never with what.
                GUILayout.Label($"Responded: {(responded.Length == 0 ? "nobody yet" : string.Join(", ", responded))}");
                GUI.color = previous;
                return;
            }

            var result = clash.result;
            if (result == null)
            {
                GUILayout.Label("Clash: resolved");
                return;
            }

            var colour = GUI.color;
            GUI.color = result.outcome == "part_dat_fight" ? Color.magenta : Color.green;
            GUILayout.Label(result.outcome == "part_dat_fight"
                ? "PART DAT FIGHT!"
                : $"CLASH: {result.winningTeamId} wins with {result.winningCardType}");
            GUI.color = colour;

            // The server's own explanation, not one composed here.
            if (!string.IsNullOrEmpty(result.explanation)) GUILayout.Label(result.explanation);

            foreach (var entry in result.entries ?? Array.Empty<ClashEntryView>())
            {
                GUILayout.Label($"  {entry.teamId}: {entry.cardType} ({entry.category})"
                    + (entry.survived ? " — survived" : " — returned"));
            }
        }

        private void DrawMarketControls(HostSharedView shared)
        {
            GUILayout.Label("MARKET", SubHeaderStyle);

            var market = shared.market;
            if (market == null || string.IsNullOrEmpty(market.marketId))
            {
                GUILayout.Label("Market: never opened");
            }
            else
            {
                GUILayout.Label(market.open
                    ? $"Market OPEN (Round {market.round}) — shopping hidden"
                    : $"Market closed (Round {market.round})"
                      + (market.revealed ? " — purchases revealed" : ""));
            }

            GUILayout.BeginHorizontal();
            GUILayout.Label("Round:", GUILayout.Width(50));
            _devMarketRound = GUILayout.TextField(_devMarketRound, GUILayout.Width(40));
            GUILayout.EndHorizontal();

            GUI.enabled = !_busy;
            GUILayout.BeginHorizontal();
            if (GUILayout.Button("OPEN MARKET"))
            {
                // Parsed here only to build the payload; the SERVER refuses
                // Round 1 (GAME_RULES_LOCKED.md §10), not this field.
                var round = int.TryParse(_devMarketRound, out var parsed) ? parsed : 2;
                _ = SubmitGameIntentAsync(SharedIntents.OpenMarket, $"{{\"round\":{round}}}");
            }
            if (GUILayout.Button("CLOSE MARKET"))
            {
                _ = SubmitGameIntentAsync(SharedIntents.CloseMarket, "{}");
            }
            GUILayout.EndHorizontal();
            GUI.enabled = true;

            // Purchases are shown to the HOST throughout — the Host has to be
            // able to close the Market cleanly and explain a balance. Players
            // do not see these until the reveal; that is enforced server-side.
            var purchases = shared.purchases ?? Array.Empty<MarketPurchaseView>();
            foreach (var purchase in purchases)
            {
                var suffix = purchase.cancelled ? " [cancelled]"
                    : purchase.expired ? " [expired]"
                    : purchase.used ? " [used]" : "";
                var surcharge = purchase.surcharge > 0 ? $" (+{purchase.surcharge} surcharge)" : "";
                GUILayout.Label($"  {purchase.teamId}: {purchase.item} — {purchase.pricePaid} BB{surcharge}{suffix}");
            }
        }

        private void DrawMacoControls(LobbySnapshot snapshot, HostSharedView shared)
        {
            GUILayout.Label("MACO MAIL", SubHeaderStyle);

            var deck = shared.macoDeck;
            if (deck != null)
            {
                // COUNTS ONLY — there is no order field to draw, for the Host
                // either. Spec §42.
                GUILayout.Label($"Draw {deck.drawPileCount} · discard {deck.discardCount} "
                    + $"· held {deck.heldOutOfDeckCount} · removed {deck.removedImpossibleCount}");
            }

            DrawTeamPicker(snapshot);

            GUI.enabled = !_busy;
            if (GUILayout.Button("DRAW MACO MAIL"))
            {
                _ = SubmitGameIntentAsync(
                    SharedIntents.DrawMacoMail,
                    $"{{\"teamId\":\"{_devSharedTeamId}\"}}");
            }
            GUI.enabled = true;

            var draws = shared.macoDraws ?? Array.Empty<MacoDrawView>();
            // Newest last; show the tail so a long game does not fill the panel.
            var from = Math.Max(0, draws.Length - 4);
            for (var i = from; i < draws.Length; i++)
            {
                var draw = draws[i];
                GUILayout.Label($"  {draw.teamId}: {draw.outcome} [{draw.result}]");
                if (!string.IsNullOrEmpty(draw.explanation))
                {
                    GUILayout.Label($"    {draw.explanation}");
                }
            }
        }

        private void DrawDealControls(LobbySnapshot snapshot, HostSharedView shared)
        {
            GUILayout.Label("HOST DEAL", SubHeaderStyle);

            // D-009 — one per round. The server enforces it; this only reports.
            var deals = shared.deals ?? Array.Empty<HostDealView>();
            foreach (var deal in deals)
            {
                GUILayout.Label($"  R{deal.roundIndex} {deal.template} -> {deal.teamId}"
                    + (string.IsNullOrEmpty(deal.choice) ? " [awaiting answer]" : $" [{deal.choice}]"));
            }

            GUILayout.BeginHorizontal();
            foreach (var template in DealTemplateButtons)
            {
                var selected = _devDealTemplate == template;
                var previous = GUI.color;
                if (selected) GUI.color = Color.cyan;
                if (GUILayout.Button(ShortTemplate(template), GUILayout.Width(88)))
                {
                    _devDealTemplate = template;
                }
                GUI.color = previous;
            }
            GUILayout.EndHorizontal();

            GUI.enabled = !_busy;
            if (GUILayout.Button($"OFFER {ShortTemplate(_devDealTemplate)} TO {_devSharedTeamId}"))
            {
                // NO AMOUNT IS SENT. GAME_RULES_LOCKED.md §9 — the maths comes
                // from the server's templates, never from this client.
                var opponent = _devSharedTeamId == TeamIds.A ? TeamIds.B : TeamIds.A;
                _ = SubmitGameIntentAsync(
                    SharedIntents.OfferDeal,
                    $"{{\"template\":\"{_devDealTemplate}\",\"teamId\":\"{_devSharedTeamId}\","
                    + $"\"opponentTeamId\":\"{opponent}\"}}");
            }
            GUI.enabled = true;
        }

        private void DrawWagerControls(HostSharedView shared)
        {
            GUILayout.Label("WAGER", SubHeaderStyle);

            var wagers = shared.wagers ?? Array.Empty<WagerView>();
            if (wagers.Length == 0)
            {
                GUILayout.Label("No wagers.");
                return;
            }

            foreach (var wager in wagers)
            {
                GUILayout.BeginHorizontal();
                GUILayout.Label($"{wager.teamId}: {wager.amount} BB [{wager.status}]",
                    GUILayout.Width(200));

                if (wager.status == "locked")
                {
                    GUI.enabled = !_busy;
                    if (GUILayout.Button("WON", GUILayout.Width(60)))
                    {
                        _ = SubmitGameIntentAsync(
                            SharedIntents.ResolveWager,
                            $"{{\"wagerId\":\"{wager.wagerId}\",\"won\":true}}");
                    }
                    if (GUILayout.Button("LOST", GUILayout.Width(60)))
                    {
                        _ = SubmitGameIntentAsync(
                            SharedIntents.ResolveWager,
                            $"{{\"wagerId\":\"{wager.wagerId}\",\"won\":false}}");
                    }
                    GUI.enabled = true;
                }
                GUILayout.EndHorizontal();
            }
        }

        /// <summary>Which team the next Host action targets.</summary>
        private void DrawTeamPicker(LobbySnapshot snapshot)
        {
            GUILayout.BeginHorizontal();
            GUILayout.Label("Team:", GUILayout.Width(50));

            // Team C appears only in three-team mode, and the count is stable
            // within one OnGUI pass because the snapshot was captured once —
            // the same helper the engine panel's BB controls use.
            foreach (var teamId in TeamsInPlay(snapshot))
            {
                var selected = _devSharedTeamId == teamId;
                var previous = GUI.color;
                if (selected) GUI.color = Color.cyan;
                if (GUILayout.Button(teamId, GUILayout.Width(80)))
                {
                    _devSharedTeamId = teamId;
                }
                GUI.color = previous;
            }
            GUILayout.EndHorizontal();
        }

        /// <summary>Shorten a challenge kind for a button face. Display only.</summary>
        private static string ShortKind(string kind)
        {
            switch (kind)
            {
                case CardChallengeKinds.Round1Trivia: return "R1 TRIV";
                case CardChallengeKinds.Round2Physical: return "R2 PHYS";
                case CardChallengeKinds.ThinkFast: return "THINK";
                case CardChallengeKinds.FamilyFeudQ1Q3: return "FF Q1-3";
                default: return kind;
            }
        }

        /// <summary>Shorten a deal template for a button face. Display only.</summary>
        private static string ShortTemplate(string template)
        {
            switch (template)
            {
                case HostDealTemplates.KeepOrRisk: return "KEEP/RISK";
                case HostDealTemplates.DoubleOrNothingIsh: return "DBL/NOTH";
                case HostDealTemplates.MysteryDeal: return "MYSTERY";
                case HostDealTemplates.OpponentsDeal: return "OPPONENT";
                default: return template;
            }
        }
    }
}
