import { useState, useCallback, useEffect } from 'react';
import { Card, evaluateHand, compareHands, SUIT_SYMBOLS } from './poker/engine';
import { GameState, Player, PlayerAction, GamePhase } from './poker/types';
import { saveGameHistory } from './poker/db';
import SetupScreen from './components/SetupScreen';
import PlayerCard from './components/PlayerCard';
import CommunityCards from './components/CommunityCards';
import CardPicker from './components/CardPicker';
import ShowdownTable from './components/ShowdownTable';
import HistoryScreen from './components/HistoryScreen';

function generateId() {
  return Math.random().toString(36).substr(2, 9);
}

function createPlayer(name: string, points: number): Player {
  return {
    id: generateId(),
    name,
    points,
    holeCards: [],
    action: 'active',
    currentBet: 0,
    isDealer: false,
    isEliminated: false,
    totalPointsWon: 0,
  };
}

const initialState: GameState = {
  phase: 'setup',
  gameName: 'Poker Scanner Pro Offline',
  players: [],
  communityCards: [],
  pot: 0,
  originalPot: 0,
  currentBet: 0,
  roundNumber: 1,
  usedCardIds: new Set(),
  winners: [],
  activePickerId: null,
  communityPickerOpen: false,
  showWinAnimation: false,
};

// Register service worker
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js').catch(console.error);
  });
}

export default function App() {
  const [state, setState] = useState<GameState>(initialState);
  const [showHistory, setShowHistory] = useState(false);
  const [addingPlayer, setAddingPlayer] = useState(false);
  const [newPlayerName, setNewPlayerName] = useState('');
  const [showInstallBanner, setShowInstallBanner] = useState(false);
  const [deferredPrompt, setDeferredPrompt] = useState<any>(null);
  const [particles, setParticles] = useState<{id: number; x: number; emoji: string}[]>([]);

  // Particles effect on win
  useEffect(() => {
    if (state.phase === 'showdown' && state.winners.length > 0 && state.showWinAnimation) {
      const emojis = ['🃏', '♠', '♥', '♦', '♣', '💰', '👑', '⭐', '🎉', '✨'];
      const newParticles = Array.from({ length: 20 }, (_, i) => ({
        id: Date.now() + i,
        x: Math.random() * 100,
        emoji: emojis[Math.floor(Math.random() * emojis.length)],
      }));
      setParticles(newParticles);
      const timer = setTimeout(() => setParticles([]), 3500);
      return () => clearTimeout(timer);
    }
  }, [state.phase, state.winners.length, state.showWinAnimation]);

  // PWA Install prompt
  useEffect(() => {
    const handler = (e: any) => {
      e.preventDefault();
      setDeferredPrompt(e);
      setShowInstallBanner(true);
    };
    window.addEventListener('beforeinstallprompt', handler);
    return () => window.removeEventListener('beforeinstallprompt', handler);
  }, []);

  const handleInstall = async () => {
    if (deferredPrompt) {
      deferredPrompt.prompt();
      const result = await deferredPrompt.userChoice;
      if (result.outcome === 'accepted') {
        setShowInstallBanner(false);
      }
    }
  };

  // ── SETUP ─────────────────────────────────────────────────
  const handleStart = useCallback((gameName: string, initialPoints: number, playerNames: string[]) => {
    const players = playerNames.map((name, idx) => {
      const p = createPlayer(name, initialPoints);
      p.isDealer = idx === 0;
      return p;
    });
    setState({
      ...initialState,
      phase: 'lobby',
      gameName,
      players,
      pot: 0,
      originalPot: 0,
      usedCardIds: new Set(),
    });
  }, []);

  // ── CARD PICKER ───────────────────────────────────────────
  const openPlayerPicker = useCallback((playerId: string) => {
    setState(prev => {
      const player = prev.players.find(p => p.id === playerId);
      if (!player || player.holeCards.length >= 2) return prev;
      return { ...prev, activePickerId: playerId, communityPickerOpen: false };
    });
  }, []);

  const openCommunityPicker = useCallback(() => {
    setState(prev => ({ ...prev, communityPickerOpen: true, activePickerId: null }));
  }, []);

  const closeCardPicker = useCallback(() => {
    setState(prev => ({ ...prev, activePickerId: null, communityPickerOpen: false }));
  }, []);

  const handleSelectCard = useCallback((card: Card) => {
    setState(prev => {
      const newUsed = new Set(prev.usedCardIds);
      newUsed.add(card.id);

      // Community card
      if (prev.communityPickerOpen) {
        const maxCards = prev.phase === 'flop' ? 3 : prev.phase === 'turn' ? 4 : 5;
        if (prev.communityCards.length >= maxCards) return prev;
        const newCards = [...prev.communityCards, card];
        const stillOpen = newCards.length < maxCards;
        return {
          ...prev,
          communityCards: newCards,
          usedCardIds: newUsed,
          communityPickerOpen: stillOpen,
        };
      }

      // Player card
      if (prev.activePickerId) {
        const players = prev.players.map(p => {
          if (p.id !== prev.activePickerId) return p;
          if (p.holeCards.length >= 2) return p;
          return { ...p, holeCards: [...p.holeCards, card] };
        });
        const player = players.find(p => p.id === prev.activePickerId);
        const stillNeedsMore = player && player.holeCards.length < 2;
        return {
          ...prev,
          players,
          usedCardIds: newUsed,
          activePickerId: stillNeedsMore ? prev.activePickerId : null,
        };
      }

      return prev;
    });
  }, []);

  const removePlayerCard = useCallback((playerId: string, cardIndex: number) => {
    setState(prev => {
      const players = prev.players.map(p => {
        if (p.id !== playerId) return p;
        const card = p.holeCards[cardIndex];
        if (!card) return p;
        const newUsed = new Set(prev.usedCardIds);
        newUsed.delete(card.id);
        const newCards = p.holeCards.filter((_, i) => i !== cardIndex);
        return { ...p, holeCards: newCards };
      });
      const removedCard = prev.players.find(p => p.id === playerId)?.holeCards[cardIndex];
      const newUsed = new Set(prev.usedCardIds);
      if (removedCard) newUsed.delete(removedCard.id);
      return { ...prev, players, usedCardIds: newUsed };
    });
  }, []);

  const removeCommunityCard = useCallback((index: number) => {
    setState(prev => {
      const card = prev.communityCards[index];
      if (!card) return prev;
      const newUsed = new Set(prev.usedCardIds);
      newUsed.delete(card.id);
      return {
        ...prev,
        communityCards: prev.communityCards.filter((_, i) => i !== index),
        usedCardIds: newUsed,
      };
    });
  }, []);

  // ── PLAYER ACTIONS ────────────────────────────────────────
  const handlePlayerAction = useCallback((playerId: string, action: PlayerAction, amount?: number) => {
    setState(prev => {
      let newPot = prev.pot;
      let newCurrentBet = prev.currentBet;

      const players = prev.players.map(p => {
        if (p.id !== playerId) return p;

        switch (action) {
          case 'check':
            return { ...p, action: 'check' as PlayerAction };

          case 'call': {
            const callAmt = Math.max(0, prev.currentBet - p.currentBet);
            const actualCall = Math.min(callAmt, p.points);
            newPot += actualCall;
            return {
              ...p,
              action: 'call' as PlayerAction,
              points: p.points - actualCall,
              currentBet: p.currentBet + actualCall,
            };
          }

          case 'raise': {
            const raiseTotal = amount ?? prev.currentBet * 2;
            const raiseDiff = Math.max(0, raiseTotal - p.currentBet);
            const actualRaise = Math.min(raiseDiff, p.points);
            newPot += actualRaise;
            newCurrentBet = Math.max(newCurrentBet, p.currentBet + actualRaise);
            return {
              ...p,
              action: 'raise' as PlayerAction,
              points: p.points - actualRaise,
              currentBet: p.currentBet + actualRaise,
            };
          }

          case 'fold':
            return { ...p, action: 'fold' as PlayerAction };

          case 'allin': {
            const allInAmt = p.points;
            newPot += allInAmt;
            newCurrentBet = Math.max(newCurrentBet, p.currentBet + allInAmt);
            return {
              ...p,
              action: 'allin' as PlayerAction,
              currentBet: p.currentBet + allInAmt,
              points: 0,
            };
          }

          default:
            return p;
        }
      });

      return { ...prev, players, pot: newPot, currentBet: newCurrentBet };
    });
  }, []);

  // ── PHASE TRANSITIONS ─────────────────────────────────────
  const advancePhase = useCallback((targetPhase: GamePhase) => {
    setState(prev => {
      if (targetPhase === 'showdown') {
        return determineWinners(prev);
      }
      return { ...prev, phase: targetPhase };
    });
  }, []);

  function determineWinners(prev: GameState): GameState {
    const activePlayers = prev.players.filter(p => p.action !== 'fold' && !p.isEliminated);

    // Calculate best hands
    const evaluated = activePlayers.map(p => {
      const allCards = [...p.holeCards, ...prev.communityCards];
      if (allCards.length < 2) {
        return { ...p, handResult: undefined };
      }
      const handResult = evaluateHand(allCards);
      return { ...p, handResult };
    });

    // Sort to find winners
    const sorted = [...evaluated].sort((a, b) => {
      if (!a.handResult && !b.handResult) return 0;
      if (!a.handResult) return -1;
      if (!b.handResult) return 1;
      return compareHands(b.handResult, a.handResult);
    });

    const best = sorted[0]?.handResult;
    const winners = best
      ? sorted.filter(p => p.handResult && compareHands(p.handResult, best) === 0)
      : [sorted[0]].filter(Boolean);

    const winnerIds = winners.map(w => w.id);
    const originalPot = prev.pot;
    const potPerWinner = winners.length > 0 ? Math.floor(originalPot / winners.length) : 0;

    // Update players with hand results and distribute pot
    const updatedPlayers = prev.players.map(p => {
      const evaled = evaluated.find(e => e.id === p.id);
      const isWinner = winnerIds.includes(p.id);
      const newPoints = isWinner ? p.points + potPerWinner : p.points;
      return {
        ...p,
        handResult: evaled?.handResult,
        points: newPoints,
        isEliminated: newPoints <= 0,
        totalPointsWon: p.totalPointsWon + (isWinner ? potPerWinner : 0),
      };
    });

    return {
      ...prev,
      phase: 'showdown',
      players: updatedPlayers,
      winners: winnerIds,
      originalPot,
      showWinAnimation: true,
    };
  }

  const handleShowdown = useCallback(() => {
    setState(prev => determineWinners(prev));
  }, []);

  const handleNewRound = useCallback(() => {
    setState(prev => {
      // Save to history before new round
      const winnerNames = prev.winners.map(id => prev.players.find(p => p.id === id)?.name ?? '');
      const isTie = prev.winners.length > 1;
      const potPerWinner = Math.floor(prev.originalPot / Math.max(1, prev.winners.length));

      const historyRecord = {
        gameName: prev.gameName,
        date: new Date().toLocaleString('id-ID'),
        totalPot: prev.originalPot,
        winner: isTie ? `SERI (${winnerNames.join(', ')})` : winnerNames[0] ?? '—',
        players: prev.players.map(p => ({
          name: p.name,
          hand: p.holeCards.map(c => `${c.rank}${SUIT_SYMBOLS[c.suit]}`).join(' '),
          combination: p.handResult?.name ?? (p.action === 'fold' ? 'FOLD' : '—'),
          rank: p.handResult?.rank ?? 0,
          status: prev.winners.includes(p.id)
            ? (isTie ? '🟨 SERI' : '🟢 MENANG')
            : p.action === 'fold'
              ? '🔴 FOLD'
              : '🔴 KALAH',
          pointsWon: prev.winners.includes(p.id) ? potPerWinner : 0,
        })),
      };

      saveGameHistory(historyRecord).catch(console.error);

      // Rotate dealer
      const currentDealerIdx = prev.players.findIndex(p => p.isDealer);
      const nextDealerIdx = (currentDealerIdx + 1) % prev.players.length;

      const newPlayers = prev.players.map((p, idx) => ({
        ...p,
        holeCards: [],
        action: 'active' as PlayerAction,
        currentBet: 0,
        isDealer: idx === nextDealerIdx,
        handResult: undefined,
      }));

      const newUsed = new Set<string>();

      return {
        ...prev,
        phase: 'deal',
        players: newPlayers,
        communityCards: [],
        pot: 0,
        originalPot: 0,
        currentBet: 0,
        roundNumber: prev.roundNumber + 1,
        usedCardIds: newUsed,
        winners: [],
        showWinAnimation: false,
        activePickerId: null,
        communityPickerOpen: false,
      };
    });
  }, []);

  const handleNewGame = useCallback(() => {
    setState(initialState);
  }, []);

  // ── ADD PLAYER DURING GAME ────────────────────────────────
  const handleAddPlayer = () => {
    const name = newPlayerName.trim() || `Pemain ${state.players.length + 1}`;
    setState(prev => {
      const avgPoints = prev.players.length > 0
        ? Math.round(prev.players.reduce((s, p) => s + p.points, 0) / prev.players.length)
        : 1000;
      return {
        ...prev,
        players: [...prev.players, createPlayer(name, avgPoints)],
      };
    });
    setNewPlayerName('');
    setAddingPlayer(false);
  };

  // ── CARD PICKER DATA ──────────────────────────────────────
  const activePlayer = state.players.find(p => p.id === state.activePickerId);
  const pickerOpen = !!state.activePickerId || state.communityPickerOpen;

  let pickerTitle = 'Pilih Kartu';
  let pickerMax = 1;
  let pickerCurrent = 0;

  if (state.activePickerId && activePlayer) {
    pickerTitle = `Kartu untuk ${activePlayer.name}`;
    pickerMax = 2 - activePlayer.holeCards.length;
    pickerCurrent = 0;
  } else if (state.communityPickerOpen) {
    const maxCards = state.phase === 'flop' ? 3 : state.phase === 'turn' ? 4 : 5;
    pickerTitle = `Kartu Community (${state.phase.toUpperCase()})`;
    pickerMax = maxCards - state.communityCards.length;
    pickerCurrent = 0;
  }

  // ── RENDER ────────────────────────────────────────────────
  if (state.phase === 'setup') {
    return (
      <div className="app">
        {showInstallBanner && (
          <div className="install-banner">
            <span>📲 Install Poker Scanner Pro ke perangkat Anda!</span>
            <button className="btn-install" onClick={handleInstall}>Install</button>
            <button className="btn-dismiss" onClick={() => setShowInstallBanner(false)}>✕</button>
          </div>
        )}
        <SetupScreen onStart={handleStart} />
      </div>
    );
  }

  if (showHistory) {
    return (
      <div className="app">
        <HistoryScreen onBack={() => setShowHistory(false)} />
      </div>
    );
  }

  const activePlayers = state.players.filter(p => p.action !== 'fold' && !p.isEliminated);

  return (
    <div className="app">
      {/* Install Banner */}
      {showInstallBanner && (
        <div className="install-banner">
          <span>📲 Install Poker Scanner Pro!</span>
          <button className="btn-install" onClick={handleInstall}>Install</button>
          <button className="btn-dismiss" onClick={() => setShowInstallBanner(false)}>✕</button>
        </div>
      )}

      {/* Top Bar */}
      <header className="app-header">
        <div className="header-left">
          <span className="header-logo">♠️ Poker Pro</span>
          <span className="header-game-name">{state.gameName}</span>
        </div>
        <div className="header-right">
          <span className="header-round">Ronde {state.roundNumber}</span>
          <button className="btn-history" onClick={() => setShowHistory(true)}>📜</button>
          <button className="btn-header-new" onClick={handleNewGame} title="Game Baru">🏠</button>
        </div>
      </header>

      {/* Phase Banner */}
      <div className="phase-banner">
        <div className="phase-steps">
          {(['lobby', 'deal', 'preflop', 'flop', 'turn', 'river', 'showdown'] as GamePhase[]).map(ph => (
            <div
              key={ph}
              className={`phase-step ${state.phase === ph ? 'phase-active' : ''} ${
                ['lobby', 'deal', 'preflop', 'flop', 'turn', 'river', 'showdown'].indexOf(state.phase) >
                ['lobby', 'deal', 'preflop', 'flop', 'turn', 'river', 'showdown'].indexOf(ph)
                  ? 'phase-done'
                  : ''
              }`}
            >
              {ph.toUpperCase()}
            </div>
          ))}
        </div>
      </div>

      <main className="app-main">
        {/* Community Cards Area */}
        <CommunityCards
          cards={state.communityCards}
          phase={state.phase}
          pot={state.pot}
          currentBet={state.currentBet}
          onOpenCommunityPicker={openCommunityPicker}
          onRemoveCommunityCard={removeCommunityCard}
        />

        {/* Round Control Buttons */}
        <div className="round-controls">
          {state.phase === 'lobby' && (
            <button className="btn-phase btn-deal" onClick={() => advancePhase('deal')}>
              🃏 BAGIKAN KARTU
            </button>
          )}
          {state.phase === 'deal' && (
            <>
              <button
                className="btn-phase btn-preflop"
                onClick={() => advancePhase('preflop')}
                disabled={activePlayers.some(p => p.holeCards.length < 2)}
              >
                ▶ MULAI PREFLOP
              </button>
              {activePlayers.some(p => p.holeCards.length < 2) && (
                <p className="phase-hint">* Setiap pemain aktif harus memiliki 2 kartu</p>
              )}
            </>
          )}
          {state.phase === 'preflop' && (
            <button className="btn-phase btn-flop" onClick={() => advancePhase('flop')}>
              🎴 FLOP (3 Kartu)
            </button>
          )}
          {state.phase === 'flop' && (
            <button
              className="btn-phase btn-turn"
              onClick={() => advancePhase('turn')}
              disabled={state.communityCards.length < 3}
            >
              🎴 TURN (1 Kartu)
            </button>
          )}
          {state.phase === 'turn' && (
            <button
              className="btn-phase btn-river"
              onClick={() => advancePhase('river')}
              disabled={state.communityCards.length < 4}
            >
              🎴 RIVER (1 Kartu)
            </button>
          )}
          {state.phase === 'river' && (
            <button
              className="btn-phase btn-showdown"
              onClick={handleShowdown}
              disabled={state.communityCards.length < 5}
            >
              🏆 SHOWDOWN!
            </button>
          )}
          {state.phase === 'showdown' && (
            <div className="showdown-done">
              <button className="btn-phase btn-new-round" onClick={handleNewRound}>🔄 Ronde Baru</button>
              <button className="btn-phase btn-new-game-inline" onClick={handleNewGame}>🏠 Game Baru</button>
            </div>
          )}
        </div>

        {/* Players Section */}
        <div className="players-section">
          <div className="players-section-header">
            <h3 className="players-section-title">👥 Pemain ({state.players.length})</h3>
            <button
              className="btn-add-player-game"
              onClick={() => setAddingPlayer(true)}
              title="Tambah Pemain"
            >
              + Tambah Pemain
            </button>
          </div>

          {addingPlayer && (
            <div className="add-player-inline">
              <input
                type="text"
                className="field-input"
                placeholder="Nama pemain baru..."
                value={newPlayerName}
                onChange={e => setNewPlayerName(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleAddPlayer()}
                autoFocus
              />
              <button className="btn-confirm-add" onClick={handleAddPlayer}>✓ Tambah</button>
              <button className="btn-cancel-add" onClick={() => setAddingPlayer(false)}>✕</button>
            </div>
          )}

          <div className="players-grid">
            {state.players.map(player => (
              <PlayerCard
                key={player.id}
                player={player}
                currentBet={state.currentBet}
                phase={state.phase}
                onAction={handlePlayerAction}
                onOpenCardPicker={openPlayerPicker}
                onRemoveCard={removePlayerCard}
                isWinner={state.winners.includes(player.id)}
              />
            ))}
          </div>
        </div>
      </main>

      {/* Card Picker Modal */}
      {pickerOpen && (
        <CardPicker
          usedCardIds={state.usedCardIds}
          onSelect={handleSelectCard}
          onClose={closeCardPicker}
          maxSelect={pickerMax}
          selectedCount={pickerCurrent}
          title={pickerTitle}
        />
      )}

      {/* Showdown Overlay */}
      {state.phase === 'showdown' && state.showWinAnimation && state.winners.length > 0 && (
        <ShowdownTable
          players={state.players}
          winners={state.winners}
          pot={state.originalPot}
          onNewRound={handleNewRound}
          onNewGame={handleNewGame}
        />
      )}

      {/* Win Particles */}
      {particles.map(p => (
        <div
          key={p.id}
          className="particle"
          style={{
            left: `${p.x}%`,
            top: '-20px',
            animationDelay: `${Math.random() * 0.5}s`,
            animationDuration: `${2 + Math.random() * 2}s`,
          }}
        >
          {p.emoji}
        </div>
      ))}

      {/* Offline indicator */}
      <div className="offline-badge">🔒 OFFLINE</div>
    </div>
  );
}
