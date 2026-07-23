import 'package:flutter/material.dart';
import 'package:picons/picons.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../app/puls_app_state.dart';
import '../../app/puls_app.dart';
import '../../core/config.dart';
import '../../core/tour_keys.dart';
import '../../core/theme/app_theme.dart';
import '../../core/widgets/lazy_indexed_stack.dart';
import '../../core/widgets/puls_footer.dart';
import '../../core/widgets/deferred_tab_builder.dart';
import '../discover/discover_screen.dart' deferred as discover;
import '../feed/feed_screen.dart' deferred as feed;
import '../home/home_screen.dart' deferred as home;
import '../portfolio/portfolio_screen.dart' deferred as portfolio;
import '../profile/profile_screen.dart' deferred as profile;
import '../profile/leaderboard_screen.dart' deferred as leaderboard;
import '../agent/agent_screen.dart' deferred as agent;
import '../agent/agent_inbox_widget.dart';
import '../onboarding/onboarding_sheet.dart';
import '../market/screens/market_terminal_screen.dart' deferred as terminal;
import 'shell_nav.dart';

class WebShell extends StatefulWidget {
  const WebShell({super.key});

  @override
  State<WebShell> createState() => _WebShellState();
}

class _WebShellState extends State<WebShell>
    with SingleTickerProviderStateMixin {
  int _index = 0;
  late final AnimationController _transCtrl;
  late final Animation<double> _fadeAnim;

  final _pages = [
    DeferredTabBuilder(
      loadLibrary: feed.loadLibrary,
      builder: (context) => feed.FeedScreen(),
    ),
    DeferredTabBuilder(
      loadLibrary: discover.loadLibrary,
      builder: (context) => discover.DiscoverScreen(),
    ),
    DeferredTabBuilder(
      loadLibrary: home.loadLibrary,
      builder: (context) => home.HomeScreen(),
    ),
    DeferredTabBuilder(
      loadLibrary: portfolio.loadLibrary,
      builder: (context) => portfolio.PortfolioScreen(),
    ),
    DeferredTabBuilder(
      loadLibrary: leaderboard.loadLibrary,
      builder: (context) => leaderboard.LeaderboardScreen(),
    ),
    DeferredTabBuilder(
      loadLibrary: agent.loadLibrary,
      builder: (context) => agent.AgentScreen(),
    ),
    DeferredTabBuilder(
      loadLibrary: profile.loadLibrary,
      builder: (context) => profile.ProfileScreen(),
    ),
  ];

  static final _items = [
    _NavItem(Picons.lightning, 'Feed', tourFeedKey),
    _NavItem(Picons.compass, 'Discover', tourDiscoverKey),
    _NavItem(Picons.playCircle, 'Home', tourHomeKey),
    _NavItem(Picons.chartBar, 'Portfolio', tourPortfolioKey),
    _NavItem(Picons.star, 'Creators', tourCreatorsKey),
    _NavItem(Picons.robot, 'Agent', tourAgentKey),
    _NavItem(Picons.userCircle, 'Profile', tourProfileKey),
  ];

  @override
  void initState() {
    super.initState();
    _transCtrl = AnimationController(
      vsync: this,
      duration: const Duration(milliseconds: 220),
      value: 1.0,
    );
    _fadeAnim = CurvedAnimation(parent: _transCtrl, curve: Curves.easeOut);
    maybeShowWelcome(this);
  }

  @override
  void dispose() {
    _transCtrl.dispose();
    super.dispose();
  }

  // Map shell-independent tab ids → this shell's page index.
  static const _tabIndex = {
    PulsTab.feed: 0,
    PulsTab.discover: 1,
    PulsTab.home: 2,
    PulsTab.portfolio: 3,
    PulsTab.leaderboard: 4,
    PulsTab.agent: 5,
    PulsTab.profile: 6,
  };

  void _goToTab(PulsTab tab) => _navigate(_tabIndex[tab] ?? 0);

  void _navigate(int i) {
    if (i == _index) {
      if (i == 0) PulsStateScope.of(context).refresh();
      return;
    }
    _transCtrl.reverse().then((_) {
      setState(() => _index = i);
      _transCtrl.forward();
    });
  }

  @override
  Widget build(BuildContext context) {
    final t = context.puls;
    final isDark = context.isDark;
    final appState = PulsStateScope.of(context);

    // Theme-aware shell background — twin brand glows (mint ◤ + pink ◥) over a
    // calm canvas, echoing the signature pulse gradient. Subtle, premium, not washy.
    final canvas = t.bg;
    final mintGlow = isDark
        ? PulsColors.brandMint.withValues(alpha: 0.14)
        : PulsColors.brandMint.withValues(alpha: 0.10);
    final pinkGlow = isDark
        ? PulsColors.brandPinkDark.withValues(alpha: 0.18)
        : PulsColors.brandPink.withValues(alpha: 0.10);
    final dotColor = isDark
        ? Colors.white.withValues(alpha: 0.035)
        : PulsColors.brandPink.withValues(alpha: 0.03);

    return ShellNavScope(
      goToTab: _goToTab,
      child: Scaffold(
        backgroundColor: canvas,
        body: Stack(
          children: [
            // ── Single layered background (pages above are transparent, so this
            //    is the ONLY background — no double-bg behind the island nav). ──
            // Base canvas.
            Positioned.fill(child: ColoredBox(color: canvas)),
            // Mint glow, upper-left.
            Positioned.fill(
              child: DecoratedBox(
                decoration: BoxDecoration(
                  gradient: RadialGradient(
                    center: const Alignment(-0.85, -0.95),
                    radius: 1.1,
                    colors: [mintGlow, canvas.withValues(alpha: 0.0)],
                    stops: const [0.0, 0.55],
                  ),
                ),
              ),
            ),
            // Pink glow, upper-right.
            Positioned.fill(
              child: DecoratedBox(
                decoration: BoxDecoration(
                  gradient: RadialGradient(
                    center: const Alignment(0.9, -0.85),
                    radius: 1.2,
                    colors: [pinkGlow, canvas.withValues(alpha: 0.0)],
                    stops: const [0.0, 0.6],
                  ),
                ),
              ),
            ),
            // Soft vertical settle so content lower down sits on calm canvas.
            Positioned.fill(
              child: DecoratedBox(
                decoration: BoxDecoration(
                  gradient: LinearGradient(
                    begin: Alignment.topCenter,
                    end: Alignment.bottomCenter,
                    colors: [canvas.withValues(alpha: 0.0), canvas],
                    stops: const [0.45, 1.0],
                  ),
                ),
              ),
            ),
            Positioned.fill(
              child: RepaintBoundary(
                child: CustomPaint(painter: _DotGridPainter(color: dotColor)),
              ),
            ),
            // ── Shell: top island nav · content · footer ───────────────────
            Column(
              children: [
                _TopNav(
                  index: _index,
                  items: _items,
                  t: t,
                  isDark: isDark,
                  onTap: _navigate,
                  onToggleTheme: appState.toggleThemeMode,
                ),
                Expanded(
                  child: FadeTransition(
                    opacity: _fadeAnim,
                    child: SlideTransition(
                      position: Tween<Offset>(
                        begin: const Offset(0.02, 0),
                        end: Offset.zero,
                      ).animate(_fadeAnim),
                      // Embedded pages set backgroundColor: Colors.transparent
                      // so the shell gradient above is the single background
                      // (fixes the double-background behind the island nav).
                      child: LazyIndexedStack(index: _index, children: _pages),
                    ),
                  ),
                ),
                const PulsFooter(),
              ],
            ),
            const AgentInboxWidget(),
          ],
        ),
      ),
    );
  }
}

// ── Top island nav ─────────────────────────────────────────────────────────────
class _TopNav extends StatelessWidget {
  const _TopNav({
    required this.index,
    required this.items,
    required this.t,
    required this.isDark,
    required this.onTap,
    required this.onToggleTheme,
  });

  final int index;
  final List<_NavItem> items;
  final PulsThemeColors t;
  final bool isDark;
  final ValueChanged<int> onTap;
  final VoidCallback onToggleTheme;

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(
      builder: (context, c) {
        // Labels only on wide screens (7 labelled pills are ~880px wide and
        // must clear the brand + right controls without overlapping).
        final showLabels = c.maxWidth >= 1300;
        // Compact: collapse brand text + wallet detail on small laptops.
        final compact = c.maxWidth < 780;

        // Row layout (brand · island · controls) so elements can never
        // overlap — the island stays centred between flexible spacers.
        return Padding(
          padding: const EdgeInsets.fromLTRB(20, 16, 20, 8),
          child: SizedBox(
            height: 56,
            child: Row(
              children: [
                _Brand(t: t, compact: compact),
                const Spacer(),
                _Island(
                  index: index,
                  items: items,
                  t: t,
                  isDark: isDark,
                  showLabels: showLabels,
                  onTap: onTap,
                ),
                const Spacer(),
                _RightControls(
                  t: t,
                  isDark: isDark,
                  compact: compact,
                  onToggleTheme: onToggleTheme,
                ),
              ],
            ),
          ),
        );
      },
    );
  }
}

class _Brand extends StatelessWidget {
  const _Brand({required this.t, this.compact = false});
  final PulsThemeColors t;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final row = Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        Container(
          width: 30,
          height: 30,
          decoration: BoxDecoration(
            color: t.brandSubtle,
            borderRadius: BorderRadius.circular(8),
          ),
          clipBehavior: Clip.antiAlias,
          child: Image.asset('assets/logo.png', fit: BoxFit.cover),
        ),
        if (!compact) ...[
          const SizedBox(width: 10),
          Text(
            'Puls',
            style: TextStyle(
              fontFamily: PulsColors.fontDisplay,
              color: t.text,
              fontSize: 18,
              fontWeight: FontWeight.w700,
              letterSpacing: -0.3,
            ),
          ),
        ],
      ],
    );
    // The brand links back to the marketing landing (pulsmarket.tech).
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: () =>
            launchUrl(Uri.parse(appBaseUrl), webOnlyWindowName: '_self'),
        child: Tooltip(message: 'pulsmarket.tech', child: row),
      ),
    );
  }
}

// ── The floating island holding the nav pills ───────────────────────────────────
class _Island extends StatefulWidget {
  const _Island({
    required this.index,
    required this.items,
    required this.t,
    required this.isDark,
    required this.showLabels,
    required this.onTap,
  });

  final int index;
  final List<_NavItem> items;
  final PulsThemeColors t;
  final bool isDark;
  final bool showLabels;
  final ValueChanged<int> onTap;

  @override
  State<_Island> createState() => _IslandState();
}

class _IslandState extends State<_Island> {
  final _tilt = ValueNotifier<Offset>(Offset.zero);

  void _onHover(PointerEvent event, Size size) {
    final x = event.localPosition.dx;
    final y = event.localPosition.dy;
    final centerX = size.width / 2;
    final centerY = size.height / 2;
    const maxTilt = 0.05; // perspective tilt limit
    _tilt.value = Offset(
      ((y - centerY) / centerY).clamp(-1.0, 1.0) * -maxTilt,
      ((x - centerX) / centerX).clamp(-1.0, 1.0) * maxTilt,
    );
  }

  void _onExit() {
    _tilt.value = Offset.zero;
  }

  @override
  void dispose() {
    _tilt.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final bg = widget.isDark ? const Color(0xFF131127) : Colors.white;
    final shadow = widget.isDark
        ? widget.t.brand.withValues(alpha: 0.22)
        : widget.t.brand.withValues(alpha: 0.08);

    return LayoutBuilder(
      builder: (context, constraints) {
        final size = Size(constraints.maxWidth > 0 ? constraints.maxWidth : 400, 52);
        return MouseRegion(
          onHover: (e) => _onHover(e, size),
          onExit: (_) => _onExit(),
          child: ValueListenableBuilder<Offset>(
            valueListenable: _tilt,
            builder: (context, tilt, child) {
              return TweenAnimationBuilder<Matrix4>(
                duration: const Duration(milliseconds: 140),
                curve: Curves.easeOutCubic,
                tween: Matrix4Tween(
                  begin: Matrix4.identity(),
                  end: Matrix4.identity()
                    ..setEntry(3, 2, 0.001)
                    ..rotateX(tilt.dx)
                    ..rotateY(tilt.dy),
                ),
                builder: (context, matrix, child) {
                  return Transform(
                    transform: matrix,
                    alignment: Alignment.center,
                    child: child,
                  );
                },
                child: child,
              );
            },
            child: Container(
              height: 52,
              padding: const EdgeInsets.symmetric(horizontal: 6),
              decoration: BoxDecoration(
                color: bg,
                borderRadius: BorderRadius.circular(26),
                border: Border.all(
                  color: widget.isDark
                      ? Colors.white.withValues(alpha: 0.06)
                      : widget.t.border,
                ),
                boxShadow: [
                  BoxShadow(color: shadow, blurRadius: 24, offset: const Offset(0, 8)),
                  BoxShadow(
                    color: shadow.withValues(alpha: 0.06),
                    blurRadius: 4,
                    offset: const Offset(0, 2),
                  ),
                ],
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: List.generate(widget.items.length, (i) {
                  final pill = _NavPill(
                    key: widget.items[i].key,
                    item: widget.items[i],
                    selected: i == widget.index,
                    showLabel: widget.showLabels,
                    t: widget.t,
                    isDark: widget.isDark,
                    onTap: () => widget.onTap(i),
                  );
                  if (widget.items[i].label == 'Agent') {
                    return KeyedSubtree(key: tourSwarmKey, child: pill);
                  }
                  return pill;
                }),
              ),
            ),
          ),
        );
      },
    );
  }
}

class _NavPill extends StatefulWidget {
  const _NavPill({
    super.key,
    required this.item,
    required this.selected,
    required this.showLabel,
    required this.t,
    required this.isDark,
    required this.onTap,
  });
  final _NavItem item;
  final bool selected;
  final bool showLabel;
  final PulsThemeColors t;
  final bool isDark;
  final VoidCallback onTap;

  @override
  State<_NavPill> createState() => _NavPillState();
}

class _NavPillState extends State<_NavPill> with SingleTickerProviderStateMixin {
  bool _hovered = false;
  late final AnimationController _pulseCtrl;

  @override
  void initState() {
    super.initState();
    _pulseCtrl = AnimationController(
      vsync: this,
      duration: const Duration(seconds: 2),
    );
    if (widget.selected) {
      _pulseCtrl.repeat(reverse: true);
    }
  }

  @override
  void didUpdateWidget(covariant _NavPill oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (widget.selected != oldWidget.selected) {
      if (widget.selected) {
        _pulseCtrl.repeat(reverse: true);
      } else {
        _pulseCtrl.stop();
      }
    }
  }

  @override
  void dispose() {
    _pulseCtrl.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = widget.t;
    final selected = widget.selected;
    final idleIcon =
        widget.isDark ? const Color(0xFF8181AA) : const Color(0xFF9A9A94);

    final pill = Container(
      margin: const EdgeInsets.symmetric(vertical: 6, horizontal: 2),
      child: AnimatedBuilder(
        animation: _pulseCtrl,
        builder: (context, child) {
          return DecoratedBox(
            decoration: BoxDecoration(
              borderRadius: BorderRadius.circular(20),
              boxShadow: [
                if (selected)
                  BoxShadow(
                    color: t.brand.withValues(alpha: 0.35 + (_pulseCtrl.value * 0.25)),
                    blurRadius: 8 + (_pulseCtrl.value * 10),
                    spreadRadius: _pulseCtrl.value * 1.2,
                  ),
              ],
            ),
            child: child,
          );
        },
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 220),
          curve: Curves.easeOutCubic,
          padding: EdgeInsets.symmetric(
            horizontal: widget.showLabel ? 14 : 11,
            vertical: 8,
          ),
          decoration: BoxDecoration(
            color: selected
                ? t.brand
                : _hovered
                    ? (widget.isDark
                        ? Colors.white.withValues(alpha: 0.05)
                        : t.surfaceRaised)
                    : Colors.transparent,
            borderRadius: BorderRadius.circular(20),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              AnimatedScale(
                scale: selected ? 1.08 : 1.0,
                duration: const Duration(milliseconds: 220),
                curve: Curves.easeOutCubic,
                child: Picon(
                  widget.item.icon,
                  size: 18,
                  color: selected ? Colors.white : idleIcon,
                ),
              ),
              if (widget.showLabel) ...[
                const SizedBox(width: 8),
                AnimatedDefaultTextStyle(
                  duration: const Duration(milliseconds: 220),
                  style: TextStyle(
                    fontSize: 13.5,
                    fontWeight: selected ? FontWeight.w700 : FontWeight.w500,
                    color: selected ? Colors.white : t.textMuted,
                  ),
                  child: Text(widget.item.label),
                ),
              ],
            ],
          ),
        ),
      ),
    );

    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: Semantics(
        // The pill is icon-only on narrow screens (Tooltip shows the label on
        // hover, but Tooltip isn't announced by screen readers). Announce it
        // as a button with the nav label + selected state so keyboard / AT
        // users can navigate the top nav.
        button: true,
        selected: widget.selected,
        label: widget.item.label,
        hint: widget.selected
            ? 'Currently on ${widget.item.label} tab'
            : 'Switch to ${widget.item.label} tab',
        excludeSemantics: true,
        child: GestureDetector(
          onTap: widget.onTap,
          child: widget.showLabel
              ? pill
              : Tooltip(message: widget.item.label, child: pill),
        ),
      ),
    );
  }
}

// ── Right-side controls: wallet · theme · network ───────────────────────────────
class _RightControls extends StatelessWidget {
  const _RightControls({
    required this.t,
    required this.isDark,
    required this.compact,
    required this.onToggleTheme,
  });
  final PulsThemeColors t;
  final bool isDark;
  final bool compact;
  final VoidCallback onToggleTheme;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        _WalletChip(t: t, compact: compact),
        const SizedBox(width: 8),
        _TerminalToggle(t: t, isDark: isDark),
        const SizedBox(width: 8),
        _ThemeToggle(t: t, isDark: isDark, onToggle: onToggleTheme),
      ],
    );
  }
}

class _WalletChip extends StatelessWidget {
  const _WalletChip({required this.t, this.compact = false});
  final PulsThemeColors t;
  final bool compact;

  @override
  Widget build(BuildContext context) {
    final wallet = WalletServiceScope.of(context);
    final ws = wallet.state;
    if (ws.walletAddress == null || ws.walletAddress!.isEmpty) {
      // Not connected → show a quiet network badge instead.
      return _NetworkBadge(t: t);
    }

    final addr = ws.walletAddress!;
    final shortAddress = addr.length > 10
        ? '${addr.substring(0, 6)}…${addr.substring(addr.length - 4)}'
        : addr;
    final usdc =
        double.tryParse(ws.usdcBalance)?.toStringAsFixed(2) ?? ws.usdcBalance;

    return Container(
      key: tourUsdcKey,
      padding: const EdgeInsets.fromLTRB(10, 7, 8, 7),
      decoration: BoxDecoration(
        color: t.surface,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: t.border),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 7,
            height: 7,
            decoration: BoxDecoration(color: t.yes, shape: BoxShape.circle),
          ),
          const SizedBox(width: 8),
          if (!compact) ...[
            Text(
              shortAddress,
              style: TextStyle(
                color: t.text,
                fontSize: 12.5,
                fontWeight: FontWeight.w600,
                fontFeatures: const [FontFeature.tabularFigures()],
              ),
            ),
            const SizedBox(width: 8),
            Container(width: 1, height: 14, color: t.border),
            const SizedBox(width: 8),
          ],
          Text(
            '\$$usdc',
            style: TextStyle(
              color: t.yes,
              fontSize: 12.5,
              fontWeight: FontWeight.w700,
              fontFeatures: const [FontFeature.tabularFigures()],
            ),
          ),
          const SizedBox(width: 6),
          _IconBtn(
            icon: Icons.logout_rounded,
            color: t.textSubtle,
            onTap: wallet.signOut,
            semanticLabel: 'Sign out',
          ),
        ],
      ),
    );
  }
}

class _NetworkBadge extends StatelessWidget {
  const _NetworkBadge({required this.t});
  final PulsThemeColors t;

  @override
  Widget build(BuildContext context) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
      decoration: BoxDecoration(
        color: t.surface,
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: t.border),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Container(
            width: 7,
            height: 7,
            decoration: BoxDecoration(color: t.yes, shape: BoxShape.circle),
          ),
          const SizedBox(width: 8),
          Text(
            'Arc',
            style: TextStyle(
              color: t.textMuted,
              fontSize: 12.5,
              fontWeight: FontWeight.w600,
            ),
          ),
        ],
      ),
    );
  }
}

class _ThemeToggle extends StatefulWidget {
  const _ThemeToggle({
    required this.t,
    required this.isDark,
    required this.onToggle,
  });
  final PulsThemeColors t;
  final bool isDark;
  final VoidCallback onToggle;

  @override
  State<_ThemeToggle> createState() => _ThemeToggleState();
}

class _ThemeToggleState extends State<_ThemeToggle> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final t = widget.t;
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: Semantics(
        button: true,
        label: widget.isDark ? 'Switch to light theme' : 'Switch to dark theme',
        excludeSemantics: true,
        child: GestureDetector(
          onTap: widget.onToggle,
          child: AnimatedContainer(
            duration: const Duration(milliseconds: 160),
            width: 38,
            height: 38,
            decoration: BoxDecoration(
              color: _hovered ? t.surface : Colors.transparent,
              borderRadius: BorderRadius.circular(999),
              border: Border.all(color: _hovered ? t.border : Colors.transparent),
            ),
            child: Center(
              child: AnimatedSwitcher(
                duration: const Duration(milliseconds: 300),
                child: Picon(
                  key: ValueKey(widget.isDark),
                  widget.isDark ? Picons.sun : Picons.moon,
                  size: 18,
                  color: t.textMuted,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _IconBtn extends StatefulWidget {
  const _IconBtn({
    required this.icon,
    required this.color,
    required this.onTap,
    this.semanticLabel,
  });
  final IconData icon;
  final Color color;
  final VoidCallback onTap;
  final String? semanticLabel;

  @override
  State<_IconBtn> createState() => _IconBtnState();
}

class _IconBtnState extends State<_IconBtn> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final label = widget.semanticLabel;
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: Semantics(
        // An icon-only button without a label is announced by screen readers
        // as a bare "button" with no context. The sign-out button (logout
        // icon) is the critical one — without this label, an AT user can't
        // tell what it does.
        button: true,
        label: label,
        excludeSemantics: label == null,
        child: GestureDetector(
          onTap: widget.onTap,
          child: Container(
            width: 26,
            height: 26,
            decoration: BoxDecoration(
              color: _hovered ? context.puls.surfaceRaised : Colors.transparent,
              borderRadius: BorderRadius.circular(8),
            ),
            child: Center(
              child: Icon(widget.icon, size: 14, color: widget.color),
            ),
          ),
        ),
      ),
    );
  }
}

class _NavItem {
  _NavItem(this.icon, this.label, this.key);
  final PiconData icon;
  final String label;
  final GlobalKey key;
}

class _DotGridPainter extends CustomPainter {
  _DotGridPainter({required this.color}) : _paint = Paint()..color = color;
  final Color color;
  final Paint _paint;

  @override
  void paint(Canvas canvas, Size size) {
    const spacing = 32.0;
    for (double x = 0; x < size.width; x += spacing) {
      for (double y = 0; y < size.height; y += spacing) {
        canvas.drawCircle(Offset(x, y), 1, _paint);
      }
    }
  }

  @override
  bool shouldRepaint(_DotGridPainter old) => old.color != color;
}

class _TerminalToggle extends StatefulWidget {
  const _TerminalToggle({
    required this.t,
    required this.isDark,
  });
  final PulsThemeColors t;
  final bool isDark;

  @override
  State<_TerminalToggle> createState() => _TerminalToggleState();
}

class _TerminalToggleState extends State<_TerminalToggle> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final t = widget.t;
    return Tooltip(
      message: 'AI Bloomberg Terminal',
      child: Semantics(
        button: true,
        label: 'Open AI Bloomberg Terminal',
        hint: 'Real-time agent trading terminal with live market events.',
        excludeSemantics: true,
        child: MouseRegion(
          cursor: SystemMouseCursors.click,
          onEnter: (_) => setState(() => _hovered = true),
          onExit: (_) => setState(() => _hovered = false),
          child: GestureDetector(
            onTap: () async {
              await terminal.loadLibrary();
              if (!context.mounted) return;
              Navigator.of(context).push(
                MaterialPageRoute(
                  builder: (context) => terminal.MarketTerminalScreen(),
                ),
              );
            },
            child: AnimatedContainer(
              duration: const Duration(milliseconds: 160),
              width: 38,
              height: 38,
              decoration: BoxDecoration(
                color: _hovered ? t.brand.withValues(alpha: 0.12) : Colors.transparent,
                borderRadius: BorderRadius.circular(999),
                border: Border.all(
                  color: _hovered ? t.brand.withValues(alpha: 0.4) : Colors.transparent,
                ),
              ),
              child: Center(
                child: Icon(
                  Icons.terminal_rounded,
                  size: 18,
                  color: _hovered ? t.brand : t.textMuted,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}
