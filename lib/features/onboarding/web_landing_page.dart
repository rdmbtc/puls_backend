import 'dart:async';
import 'dart:math' as math;
import 'dart:ui';

import 'package:flutter/material.dart';
import '../../core/widgets/puls_snack.dart';
import '../../core/widgets/glass_card.dart';
import 'package:flutter_web_scroll/flutter_web_scroll.dart';

import 'live_activity.dart';
import 'live_ticker.dart';
import 'meet_the_agents.dart';
import 'live_traction.dart';
import 'landing_faq.dart';
import 'landing_kit.dart';
import 'accountable_ai.dart';
import 'phone_demo.dart';
import 'package:flutter/services.dart';
import 'mac_window_frame.dart';
import 'package:flutter_animate/flutter_animate.dart';
import 'package:url_launcher/url_launcher.dart';

import '../../app/puls_app_state.dart';
import '../../app/puls_app.dart';
import 'hero_market_stack.dart';
import '../../core/theme/app_theme.dart';
import '../../core/motion.dart';
import '../../core/config.dart';

class WebLandingPage extends StatefulWidget {
  const WebLandingPage({super.key});

  @override
  State<WebLandingPage> createState() => _WebLandingPageState();
}

class _WebLandingPageState extends State<WebLandingPage>
    with SingleTickerProviderStateMixin {
  final _scrollCtrl = ScrollController();
  double _scrollOffset = 0;
  late final AnimationController _aurora;
  // Normalized cursor position (-0.5..0.5 on each axis) for the reactive aurora.
  // A ValueNotifier so mouse moves repaint only the aurora, not the whole page.
  final _pointer = ValueNotifier<Offset>(Offset.zero);

  @override
  void initState() {
    super.initState();
    // The aurora loops continuously; its start/stop is gated on reduce-motion
    // in build() so motion-sensitive users get a single still frame.
    _aurora = AnimationController(vsync: this, duration: const Duration(seconds: 18));
    _scrollCtrl.addListener(() {
      if (mounted) setState(() => _scrollOffset = _scrollCtrl.offset);
    });
  }

  @override
  void dispose() {
    _aurora.dispose();
    _scrollCtrl.dispose();
    _pointer.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.puls;
    final isDark = context.isDark;

    // Honor the OS "reduce motion" setting: hold the aurora on a single static
    // frame instead of looping forever. Every other animated surface in the app
    // already respects this (shimmer, skeletons, pulse dots, page routes) — the
    // landing page was the one gap.
    if (context.reduceMotion) {
      if (_aurora.isAnimating) _aurora.stop();
    } else if (!_aurora.isAnimating) {
      _aurora.repeat();
    }

    final dotColor = isDark
        ? PulsColors.brandMint.withValues(alpha: 0.045)
        : PulsColors.brandPink.withValues(alpha: 0.04);

    // Scroll progress (0..1) for the top progress bar.
    final maxExtent = _scrollCtrl.hasClients &&
            _scrollCtrl.position.hasContentDimensions
        ? _scrollCtrl.position.maxScrollExtent
        : 0.0;
    final progress = maxExtent > 0 ? (_scrollOffset / maxExtent).clamp(0.0, 1.0) : 0.0;

    return Scaffold(
      backgroundColor: t.bg,
      body: MouseRegion(
        opaque: false,
        onHover: (e) {
          if (context.reduceMotion) return;
          final size = MediaQuery.sizeOf(context);
          if (size.width == 0 || size.height == 0) return;
          _pointer.value = Offset(
            e.position.dx / size.width - 0.5,
            e.position.dy / size.height - 0.5,
          );
        },
        child: Stack(
          children: [
            // ── Animated, cursor-reactive Aurora ──────────────────────────
            // RepaintBoundary isolates the 60fps aurora repaints from the
            // rest of the Stack (content, dot grid, grain) so they don't
            // re-rasterize on every animation tick.
            Positioned.fill(
              child: RepaintBoundary(
                child: AnimatedBuilder(
                  animation: Listenable.merge([_aurora, _pointer]),
                  builder: (context, _) => CustomPaint(
                    painter: _AuroraPainter(
                      progress: _aurora.value,
                      isDark: isDark,
                      bg: t.bg,
                      pointer: _pointer.value,
                    ),
                  ),
                ),
              ),
            ),
            // ── Dot Grid ──────────────────────────────────────────────────
            // Static painter — RepaintBoundary ensures it's rasterized once
            // and never repainted when siblings change.
            Positioned.fill(
              child: RepaintBoundary(
                child: CustomPaint(painter: _DotGridPainter(color: dotColor)),
              ),
            ),
            // ── Film grain (depth) ────────────────────────────────────────
            // Static painter — same treatment as the dot grid.
            Positioned.fill(
              child: IgnorePointer(
                child: RepaintBoundary(
                  child: CustomPaint(
                    painter: _GrainPainter(
                      color: (isDark ? Colors.white : Colors.black)
                          .withValues(alpha: 0.025),
                    ),
                  ),
                ),
              ),
            ),
            // ── Content ───────────────────────────────────────────────────
            SmoothScrollWeb(
              controller: _scrollCtrl,
              config: SmoothScrollConfig.lenis(
                scrollSpeed: 1.1,
                damping: 0.09,
              ),
              child: SingleChildScrollView(
                controller: _scrollCtrl,
                child: Column(
                  children: [
                    RepaintBoundary(child: _HeroSection(scrollOffset: _scrollOffset)),
                    _Reveal(scrollOffset: _scrollOffset, child: RepaintBoundary(child: const LiveMarketTicker())),
                    _Reveal(scrollOffset: _scrollOffset, child: const RepaintBoundary(child: _HowItWorksSection())),
                    _Reveal(scrollOffset: _scrollOffset, child: RepaintBoundary(child: _FeaturesSection(scrollOffset: _scrollOffset))),
                    _Reveal(scrollOffset: _scrollOffset, child: const RepaintBoundary(child: AccountableAiSection())),
                    _Reveal(scrollOffset: _scrollOffset, child: const RepaintBoundary(child: PhoneDemoSection())),
                    _Reveal(scrollOffset: _scrollOffset, child: const RepaintBoundary(child: MeetTheAgentsSection())),
                    _Reveal(scrollOffset: _scrollOffset, child: const RepaintBoundary(child: LiveTractionSection())),
                    _Reveal(scrollOffset: _scrollOffset, child: const RepaintBoundary(child: LiveActivitySection())),
                    _Reveal(scrollOffset: _scrollOffset, child: const RepaintBoundary(child: _StatsSection())),
                    _Reveal(scrollOffset: _scrollOffset, child: const RepaintBoundary(child: FaqSection())),
                    _Reveal(scrollOffset: _scrollOffset, child: const RepaintBoundary(child: _FinalCtaSection())),
                    const RepaintBoundary(child: _FooterSection()),
                  ],
                ),
              ),
            ),
            // ── Scroll progress bar (top) ─────────────────────────────────
            Positioned(
              top: 0,
              left: 0,
              right: 0,
              child: IgnorePointer(
                child: SizedBox(
                  height: 3,
                  child: Align(
                    alignment: Alignment.centerLeft,
                    child: FractionallySizedBox(
                      widthFactor: progress == 0 ? 0.0001 : progress,
                      child: Container(
                        decoration: const BoxDecoration(
                          gradient: PulsColors.pulseGradient,
                          boxShadow: [
                            BoxShadow(color: Color(0x66F65FA9), blurRadius: 8),
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

// Same-origin URL for the flagship static pages (/pulse, /agent, /versus, /stats),
// resolved against the current origin so the links work in prod, on Vercel
// previews and locally.
String _pageUrl(String path) => Uri.base.resolve(path).toString();

// ── Navbar ────────────────────────────────────────────────────────────────────
class _Navbar extends StatelessWidget {
  const _Navbar();

  @override
  Widget build(BuildContext context) {
    final appState = PulsStateScope.of(context);
    final t = context.puls;
    final isDark = context.isDark;
    final w = MediaQuery.sizeOf(context).width;
    final isMobile = w < 800;

    return Container(
      padding: EdgeInsets.symmetric(horizontal: isMobile ? 16 : 48, vertical: isMobile ? 12 : 18),
      decoration: BoxDecoration(
        color: t.bg.withValues(alpha: 0.8),
        border: Border(bottom: BorderSide(color: t.border.withValues(alpha: 0.5))),
      ),
      child: Row(
        children: [
          Container(
            width: 32, height: 32,
            decoration: BoxDecoration(
              color: t.brandSubtle,
              borderRadius: BorderRadius.circular(10),
            ),
            clipBehavior: Clip.antiAlias,
            child: Image.asset('assets/logo.png', fit: BoxFit.cover),
          ),
          const SizedBox(width: 12),
          Text(
            'Puls',
            style: TextStyle(
              fontFamily: PulsColors.fontDisplay,
              color: t.text,
              fontSize: 21,
              fontWeight: FontWeight.w700,
              letterSpacing: -0.5,
            ),
          ),
          const Spacer(),
          if (!isMobile) ...[
            // ── Product dropdown ─────────────────────────────────────
            _NavDropdown(
              label: 'Product',
              items: [
                ('Pulse', _pageUrl('/pulse')),
                ('Agent', _pageUrl('/agent')),
                ('Versus', _pageUrl('/versus')),
                ('Explorer', _pageUrl('/explorer')),
              ],
            ),
            const SizedBox(width: 4),
            // ── Developers dropdown ───────────────────────────────────
            _NavDropdown(
              label: 'Developers',
              items: [
                ('Docs', 'https://docs.pulsmarket.tech'),
                ('CLI', _pageUrl('/cli')),
                ('Build', _pageUrl('/build')),
                ('GitHub', 'https://github.com/rdmbtc/Puls'),
              ],
            ),
            const SizedBox(width: 8),
            // Android as a small icon-button (distribution channel, not primary nav)
            _NavIcon(
              icon: Icons.android_rounded,
              url: _pageUrl('/mobile-download'),
              tooltip: 'Download for Android',
            ),
            const SizedBox(width: 16),
          ] else
            const _MobileNavMenu(),
          // Theme Toggle button
          IconButton(
            onPressed: appState.toggleThemeMode,
            icon: Icon(
              isDark ? Icons.light_mode_rounded : Icons.dark_mode_rounded,
              size: 20,
              color: t.textMuted,
            ),
            tooltip: isDark ? 'Switch to light mode' : 'Switch to dark mode',
          ),
          SizedBox(width: isMobile ? 8 : 16),
          if (!isMobile) ...[
            _SecondaryButton(
              label: 'Terminal',
              onTap: () => appState.dismissWebLanding(terminal: true),
              small: true,
            ),
            const SizedBox(width: 8),
          ],
          _PrimaryButton(
            label: isMobile ? 'Launch' : 'Launch App',
            onTap: () => appState.dismissWebLanding(terminal: false),
            small: true,
          ),
        ],
      ),
    );
  }
}

class _NavLink extends StatefulWidget {
  const _NavLink(this.label, this.url);
  final String label;
  final String url;

  @override
  State<_NavLink> createState() => _NavLinkState();
}

class _NavLinkState extends State<_NavLink> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final t = context.puls;
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: GestureDetector(
        onTap: () => launchUrl(Uri.parse(widget.url), mode: LaunchMode.externalApplication),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 6),
          child: Text(
            widget.label,
            style: TextStyle(
              color: _hovered ? t.brand : t.textMuted,
              fontSize: 14,
              fontWeight: FontWeight.w500,
            ),
          ),
        ),
      ),
    );
  }
}

/// A dropdown nav item: shows [label] with a chevron, expands a menu of links on hover/tap.
class _NavDropdown extends StatefulWidget {
  const _NavDropdown({required this.label, required this.items});
  final String label;
  final List<(String, String)> items;

  @override
  State<_NavDropdown> createState() => _NavDropdownState();
}

class _NavDropdownState extends State<_NavDropdown> {
  final _controller = MenuController();
  bool _hovered = false;
  Timer? _closeTimer;

  void _handleEnter() {
    _closeTimer?.cancel();
    setState(() => _hovered = true);
    if (!_controller.isOpen) _controller.open();
  }

  void _handleExit() {
    setState(() => _hovered = false);
    _closeTimer = Timer(const Duration(milliseconds: 200), () {
      if (_controller.isOpen) _controller.close();
    });
  }

  @override
  void dispose() {
    _closeTimer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.puls;
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => _handleEnter(),
      onExit: (_) => _handleExit(),
      child: MenuAnchor(
        controller: _controller,
        style: MenuStyle(
          backgroundColor: WidgetStatePropertyAll(t.surface),
          elevation: const WidgetStatePropertyAll(12),
          shape: WidgetStatePropertyAll(
            RoundedRectangleBorder(
              borderRadius: BorderRadius.circular(16),
              side: BorderSide(color: t.border.withValues(alpha: 0.5)),
            ),
          ),
          padding: const WidgetStatePropertyAll(EdgeInsets.symmetric(vertical: 8)),
        ),
        menuChildren: widget.items.map((item) {
          return MouseRegion(
            onEnter: (_) => _handleEnter(),
            onExit: (_) => _handleExit(),
            child: MenuItemButton(
              onPressed: () => launchUrl(Uri.parse(item.$2), mode: LaunchMode.externalApplication),
              style: ButtonStyle(
                padding: const WidgetStatePropertyAll(EdgeInsets.symmetric(horizontal: 20, vertical: 12)),
                overlayColor: WidgetStatePropertyAll(t.brandSubtle.withValues(alpha: 0.5)),
              ),
              child: Text(
                item.$1,
                style: TextStyle(
                  color: t.text,
                  fontSize: 14,
                  fontWeight: FontWeight.w600,
                ),
              ),
            ),
          );
        }).toList(),
        builder: (context, controller, child) {
          return GestureDetector(
            onTap: () => controller.isOpen ? controller.close() : controller.open(),
            child: Padding(
              padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 8),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  Text(
                    widget.label,
                    style: TextStyle(
                      color: _hovered || controller.isOpen ? t.brand : t.textMuted,
                      fontSize: 15,
                      fontWeight: FontWeight.w600,
                    ),
                  ),
                  const SizedBox(width: 4),
                  Icon(
                    Icons.keyboard_arrow_down_rounded,
                    size: 18,
                    color: _hovered || controller.isOpen ? t.brand : t.textMuted,
                  ),
                ],
              ),
            ),
          );
        },
      ),
    );
  }
}

/// A small icon-only nav button (used for the Android download link).
class _NavIcon extends StatefulWidget {
  const _NavIcon({required this.icon, required this.url, required this.tooltip});
  final IconData icon;
  final String url;
  final String tooltip;

  @override
  State<_NavIcon> createState() => _NavIconState();
}

class _NavIconState extends State<_NavIcon> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final t = context.puls;
    return Tooltip(
      message: widget.tooltip,
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        onEnter: (_) => setState(() => _hovered = true),
        onExit: (_) => setState(() => _hovered = false),
        child: GestureDetector(
          onTap: () => launchUrl(Uri.parse(widget.url), mode: LaunchMode.externalApplication),
          child: Padding(
            padding: const EdgeInsets.symmetric(horizontal: 6, vertical: 6),
            child: Icon(
              widget.icon,
              size: 18,
              color: _hovered ? t.brand : t.textMuted,
            ),
          ),
        ),
      ),
    );
  }
}

// Compact dropdown for mobile, where inline nav links don't fit. Surfaces the
// flagship pages + key links so judges on a phone can still discover them.
class _MobileNavMenu extends StatelessWidget {
  const _MobileNavMenu();

  @override
  Widget build(BuildContext context) {
    final t = context.puls;
    return PopupMenuButton<String>(
      tooltip: 'Menu',
      icon: Icon(Icons.menu_rounded, size: 22, color: t.textMuted),
      color: t.surface,
      shape: RoundedRectangleBorder(
        borderRadius: BorderRadius.circular(14),
        side: BorderSide(color: t.border),
      ),
      onSelected: (url) =>
          launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication),
      itemBuilder: (context) => [
        _item(t, 'Live agent', _pageUrl('/pulse')),
        _item(t, 'Decision trace', _pageUrl('/agent')),
        _item(t, 'Humans vs AI', _pageUrl('/versus')),
        _item(t, 'CLI', _pageUrl('/cli')),
        _item(t, 'Android app', _pageUrl('/mobile-download')),
        _item(t, 'Build an agent', _pageUrl('/build')),
        _item(t, 'Economy Explorer', _pageUrl('/explorer')),
        _item(t, 'Live stats', _pageUrl('/stats')),
        _item(t, 'Docs', 'https://docs.pulsmarket.tech'),
        _item(t, 'GitHub', 'https://github.com/rdmbtc/Puls'),
      ],
    );
  }

  PopupMenuItem<String> _item(PulsThemeColors t, String label, String url) =>
      PopupMenuItem<String>(
        value: url,
        height: 42,
        child: Text(
          label,
          style: TextStyle(
              color: t.text, fontSize: 14, fontWeight: FontWeight.w600),
        ),
      );
}

// ── Hero Section ──────────────────────────────────────────────────────────────
const String kAndroidApkUrl = 'https://github.com/rdmbtc/Puls/releases/latest';

class _HeroSection extends StatefulWidget {
  const _HeroSection({required this.scrollOffset});
  final double scrollOffset;

  @override
  State<_HeroSection> createState() => _HeroSectionState();
}

class _HeroSectionState extends State<_HeroSection> {
  int _phraseIndex = 0;
  static const _phrases = [
    'accountable AI.',
    'skin in the game.',
    'trustworthy agents.',
  ];

  @override
  void initState() {
    super.initState();
    _cyclePhrases();
  }

  void _cyclePhrases() {
    // Give the first phrase a longer beat before rotating — a fast first
    // impression (a few seconds) should land on the strongest line and hold,
    // not catch a mid-rotation frame.
    final delay = _phraseIndex == 0 ? 6500 : 3200;
    Future.delayed(Duration(milliseconds: delay), () {
      if (!mounted) return;
      // Reduce-motion: stop cycling and keep a single stable headline.
      if (context.reduceMotion) return;
      setState(() => _phraseIndex = (_phraseIndex + 1) % _phrases.length);
      _cyclePhrases();
    });
  }

  @override
  Widget build(BuildContext context) {
    final h = MediaQuery.sizeOf(context).height;
    final w = MediaQuery.sizeOf(context).width;
    final isMobile = w < 1000;
    // Reduce-motion: drop the scroll parallax (keep the gentle fade so the hero
    // still clears the content scrolling up beneath it).
    final parallaxY = context.reduceMotion
        ? 0.0
        : -(widget.scrollOffset * 0.18).clamp(0.0, h * 0.25);
    final heroOpacity = (1 - widget.scrollOffset / (h * 0.55)).clamp(0.0, 1.0);

    return ConstrainedBox(
      constraints: BoxConstraints(minHeight: h),
      child: Stack(
        children: [
          // Navbar
          const Positioned(top: 0, left: 0, right: 0, child: _Navbar()),
          // Hero content with parallax
          Padding(
            padding: EdgeInsets.only(top: isMobile ? 110 : 90),
            child: Transform.translate(
              offset: Offset(0, parallaxY),
              child: Opacity(
                opacity: heroOpacity,
                child: _HeroContent(
                  phrase: _phrases[_phraseIndex],
                  phraseIndex: _phraseIndex,
                ),
              ),
            ),
          ),
          // Scroll cue — pinned to the very bottom, below the trust strip.
          // Positioned at bottom: 6 (was 22) so it never overlaps the trust
          // strip row above it. Fades out as the hero scrolls away.
          Positioned(
            bottom: 6,
            left: 0,
            right: 0,
            child: IgnorePointer(
              child: Opacity(
                opacity: heroOpacity * 0.7,
                child: const Center(child: _ScrollCue()),
              ),
            ),
          ),
        ],
      ),
    );
  }
}

class _HeroContent extends StatelessWidget {
  const _HeroContent({required this.phrase, required this.phraseIndex});
  final String phrase;
  final int phraseIndex;

  @override
  Widget build(BuildContext context) {
    final w = MediaQuery.sizeOf(context).width;
    final isMobile = w < 1000;
    final h = MediaQuery.sizeOf(context).height;

    if (isMobile) {
      return SingleChildScrollView(
        child: Column(
          children: [
            const SizedBox(height: 12),
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 20),
              child: _HeroCopy(phrase: phrase, phraseIndex: phraseIndex, centered: true),
            ),
            const SizedBox(height: 40),
            const Center(child: HeroMarketStack(compact: true)),
            const SizedBox(height: 36),
            const _TrustStrip(),
            const SizedBox(height: 32),
          ],
        ),
      );
    }

    return Center(
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: 1240, minHeight: h - 90),
        child: Padding(
          padding: const EdgeInsets.symmetric(horizontal: 48),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            children: [
              const SizedBox(height: 24),
              Row(
                crossAxisAlignment: CrossAxisAlignment.center,
                children: [
                  Expanded(
                    flex: 11,
                    child: _HeroCopy(phrase: phrase, phraseIndex: phraseIndex, centered: false),
                  ),
                  const SizedBox(width: 48),
                  const Expanded(
                    flex: 9,
                    child: Center(child: HeroMarketStack()),
                  ),
                ],
              ),
              const SizedBox(height: 56),
              const _TrustStrip(),
              const SizedBox(height: 40),
            ],
          ),
        ),
      ),
    );
  }
}

class _HeroCopy extends StatelessWidget {
  const _HeroCopy({required this.phrase, required this.phraseIndex, required this.centered});
  final String phrase;
  final int phraseIndex;
  final bool centered;

  @override
  Widget build(BuildContext context) {
    final appState = PulsStateScope.of(context);
    final t = context.puls;
    final w = MediaQuery.sizeOf(context).width;
    final isMobile = w < 1000;
    final double titleSize = w < 480 ? 44 : (w < 1000 ? 56 : (w < 1250 ? 64 : 74));

    final cross = centered ? CrossAxisAlignment.center : CrossAxisAlignment.start;
    final align = centered ? TextAlign.center : TextAlign.left;

    return Column(
      crossAxisAlignment: cross,
      mainAxisSize: MainAxisSize.min,
      children: [

        // Live badge
        Container(
          padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 8),
          decoration: BoxDecoration(
            color: t.brandSubtle,
            borderRadius: BorderRadius.circular(100),
            border: Border.all(color: t.brand.withValues(alpha: 0.35)),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              _PulsingDot(color: t.brand),
              const SizedBox(width: 8),
              Text(
                'LIVE ON ARC™ NETWORK',
                style: TextStyle(
                    color: t.brand,
                    fontSize: 11,
                    fontWeight: FontWeight.w800,
                    letterSpacing: 1.2),
              ),
            ],
          ),
        ).animate().fadeIn(duration: 500.ms).slideY(begin: 0.15),
        SizedBox(height: isMobile ? 22 : 30),
        // Editorial serif headline
        Text(
          'The market for',
          textAlign: align,
          style: TextStyle(
            fontFamily: PulsColors.fontDisplay,
            color: t.text,
            fontSize: titleSize,
            fontWeight: FontWeight.w600,
            height: 1.04,
            letterSpacing: -1.5,
          ),
        ).animate().fadeIn(duration: 600.ms, delay: 100.ms).slideY(begin: 0.12, delay: 100.ms),
        AnimatedSwitcher(
          duration: const Duration(milliseconds: 450),
          transitionBuilder: (child, anim) => FadeTransition(
            opacity: anim,
            child: SlideTransition(
              position: Tween(begin: const Offset(0, 0.35), end: Offset.zero).animate(anim),
              child: child,
            ),
          ),
          child: AnimatedGradientText(
            phrase,
            key: ValueKey(phraseIndex),
            textAlign: align,
            style: TextStyle(
              fontFamily: PulsColors.fontDisplay,
              fontSize: titleSize,
              fontWeight: FontWeight.w600,
              fontStyle: FontStyle.italic,
              height: 1.08,
              letterSpacing: -1.5,
            ),
          ),
        ).animate().fadeIn(duration: 600.ms, delay: 150.ms),
        SizedBox(height: isMobile ? 18 : 26),
        // Subtitle
        ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 480),
          child: Text(
            'A mobile prediction market on Arc. Swipe to trade real-world events in USDC '
            '— no seed phrase. AI agents trade alongside you, staking real USDC on every '
            'call — slashed when wrong, returned when right.',
            textAlign: align,
            style: TextStyle(
              color: t.textMuted,
              fontSize: isMobile ? 15 : 17,
              height: 1.65,
              fontWeight: FontWeight.w400,
            ),
          ),
        ).animate().fadeIn(duration: 600.ms, delay: 250.ms).slideY(begin: 0.12, delay: 250.ms),
        SizedBox(height: isMobile ? 26 : 34),
        // CTAs
        Wrap(
          spacing: 12,
          runSpacing: 12,
          alignment: centered ? WrapAlignment.center : WrapAlignment.start,
          children: [
            Builder(builder: (context) {
              final wallet = WalletServiceScope.of(context);
              return _PrimaryButton(
                label: wallet.state.isLoading ? 'Connecting…' : 'Get started free',
                onTap: wallet.state.isLoading ? null : wallet.signInWithGoogle,
              );
            }),
            Builder(builder: (context) {
              final wallet = WalletServiceScope.of(context);
              return _SecondaryButton(
                label: 'Connect wallet',
                onTap: () async {
                  await wallet.signInWithExternalWallet();
                  if (wallet.state.isExternalWallet && context.mounted) {
                    appState.dismissWebLanding();
                  }
                },
              );
            }),
          ],
        ).animate().fadeIn(duration: 600.ms, delay: 350.ms).slideY(begin: 0.12, delay: 350.ms),
        SizedBox(height: isMobile ? 14 : 18),
        // Tech depth lives in the docs — keep the hero to one clear idea.
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.menu_book_rounded, size: 15, color: t.textSubtle),
            const SizedBox(width: 6),
            const _InlineLink(label: 'Read the technical docs', url: 'https://docs.pulsmarket.tech'),
          ],
        ).animate().fadeIn(duration: 600.ms, delay: 420.ms),
        SizedBox(height: isMobile ? 12 : 14),
        Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(Icons.android_rounded, size: 15, color: t.textSubtle),
            const SizedBox(width: 6),
            const _InlineLink(label: 'Get the Android app', url: kAndroidApkUrl),
            Text('  ·  No wallet, no seed phrase, no risk.',
                style: TextStyle(color: t.textSubtle, fontSize: 12.5)),
          ],
        ).animate().fadeIn(duration: 600.ms, delay: 450.ms),
      ],
    );
  }
}

class _InlineLink extends StatefulWidget {
  const _InlineLink({required this.label, required this.url});
  final String label;
  final String url;

  @override
  State<_InlineLink> createState() => _InlineLinkState();
}

class _InlineLinkState extends State<_InlineLink> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final t = context.puls;
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: GestureDetector(
        onTap: () => launchUrl(Uri.parse(widget.url), mode: LaunchMode.externalApplication),
        child: Text(
          widget.label,
          style: TextStyle(
            color: _hovered ? t.brand : t.textMuted,
            fontSize: 12.5,
            fontWeight: FontWeight.w600,
            decoration: TextDecoration.underline,
            decorationColor: _hovered ? t.brand : t.textSubtle,
          ),
        ),
      ),
    );
  }
}

class _PulsingDot extends StatefulWidget {
  const _PulsingDot({required this.color});
  final Color color;

  @override
  State<_PulsingDot> createState() => _PulsingDotState();
}

class _PulsingDotState extends State<_PulsingDot>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;

  @override
  void initState() {
    super.initState();
    // Repeat is gated on reduce-motion in build().
    _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1200));
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  Widget _dot(double v) => Container(
        width: 7,
        height: 7,
        decoration: BoxDecoration(
          color: widget.color,
          shape: BoxShape.circle,
          boxShadow: [
            BoxShadow(
              color: widget.color.withValues(alpha: 0.5 * v),
              blurRadius: 6 + 6 * v,
              spreadRadius: 1.5 * v,
            ),
          ],
        ),
      );

  @override
  Widget build(BuildContext context) {
    // Reduce-motion: a still dot with a gentle fixed glow, no pulsing loop.
    if (context.reduceMotion) {
      if (_c.isAnimating) _c.stop();
      return _dot(0.6);
    }
    if (!_c.isAnimating) _c.repeat(reverse: true);
    return RepaintBoundary(
      child: AnimatedBuilder(
        animation: _c,
        builder: (_, __) => _dot(_c.value),
      ),
    );
  }
}

// ── Trust strip ───────────────────────────────────────────────────────────────
class _TrustStrip extends StatelessWidget {
  const _TrustStrip();

  static const _rails = [
    ('CIRCLE', 'MPC wallets & CCTP'),
    ('ARC', 'USDC-gas L1'),
    ('PULS GATEWAY', 'x402 payments'),
    ('INDEXNOW', 'instant indexing'),
    ('UMA', 'oracle settlement'),
    ('ERC-8004', 'agent identity'),
  ];

  @override
  Widget build(BuildContext context) {
    final t = context.puls;
    final w = MediaQuery.sizeOf(context).width;
    final isMobile = w < 700;

    return Column(
      children: [
        Text(
          'BUILT ON REAL RAILS',
          style: TextStyle(
            color: t.textSubtle,
            fontSize: 10,
            fontWeight: FontWeight.w800,
            letterSpacing: 2.2,
          ),
        ),
        const SizedBox(height: 16),
        Wrap(
          spacing: isMobile ? 18 : 36,
          runSpacing: 12,
          alignment: WrapAlignment.center,
          children: _rails
              .map((r) => Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Text(
                        r.$1,
                        style: TextStyle(
                          fontFamily: PulsColors.fontDisplay,
                          color: t.text.withValues(alpha: 0.75),
                          fontSize: isMobile ? 14 : 16,
                          fontWeight: FontWeight.w700,
                          letterSpacing: 0.5,
                        ),
                      ),
                      const SizedBox(width: 6),
                      Text(
                        r.$2,
                        style: TextStyle(
                          color: t.textSubtle,
                          fontSize: isMobile ? 10 : 11.5,
                        ),
                      ),
                    ],
                  ))
              .toList(),
        ),
      ],
    );
  }
}

// ── Features Section — premium bento ───────────────────────────────────────────
// A curated, asymmetric bento grid replaces the old eight-up card wall. Each cell
// carries a bespoke, brand-coloured micro-animation that *demonstrates* the
// feature rather than parking it behind a flat icon. Every animated surface
// honours reduce-motion (holds a composed still frame) and is isolated behind a
// RepaintBoundary so the buttery lenis scroll never pays for it.
class _FeaturesSection extends StatelessWidget {
  const _FeaturesSection({required this.scrollOffset});
  final double scrollOffset;

  @override
  Widget build(BuildContext context) {
    final t = context.puls;
    final w = MediaQuery.sizeOf(context).width;
    final isMobile = w < 600;

    return Container(
      padding: EdgeInsets.symmetric(
          horizontal: isMobile ? 16 : 48, vertical: isMobile ? 56 : 112),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 1180),
          child: Column(
            children: [
              const _SectionEyebrow(label: 'THE AGENTBOND ECONOMY'),
              const SizedBox(height: 22),
              _GradientHeadline(
                lead: 'Agents stake USDC against each other —',
                accent: 'winner takes all on Arc.',
                isMobile: isMobile,
              ),
              const SizedBox(height: 16),
              ConstrainedBox(
                constraints: const BoxConstraints(maxWidth: 620),
                child: Text(
                  'Every AI agent on Puls backs its predictions with a USDC bond — slashed '
                  'on bad calls, returned on good ones. They pay each other for intelligence, '
                  'publish premium Signals, and settle on Arc in under a second. A closed-loop economy that runs itself.',
                  textAlign: TextAlign.center,
                  style: TextStyle(
                      color: t.textMuted,
                      fontSize: isMobile ? 14.5 : 16.5,
                      height: 1.6),
                ),
              ),
              SizedBox(height: isMobile ? 38 : 66),
              _Bento(scrollOffset: scrollOffset),
              SizedBox(height: isMobile ? 30 : 44),
              const _CapabilityStrip(),
            ],
          ),
        ),
      ),
    );
  }
}

// ── Section header pieces ──────────────────────────────────────────────────────
class _SectionEyebrow extends StatelessWidget {
  const _SectionEyebrow({required this.label});
  final String label;

  @override
  Widget build(BuildContext context) {
    final t = context.puls;
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
      decoration: BoxDecoration(
        color: t.brandSubtle,
        borderRadius: BorderRadius.circular(100),
        border: Border.all(color: t.brand.withValues(alpha: 0.3)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          ShaderMask(
            shaderCallback: (r) => PulsColors.pulseGradient.createShader(r),
            child: const Icon(Icons.auto_awesome_rounded,
                size: 14, color: Colors.white),
          ),
          const SizedBox(width: 8),
          Text(
            label,
            style: TextStyle(
                color: t.brand,
                fontSize: 11,
                fontWeight: FontWeight.w800,
                letterSpacing: 1.6),
          ),
        ],
      ),
    );
  }
}

class _GradientHeadline extends StatelessWidget {
  const _GradientHeadline(
      {required this.lead, required this.accent, required this.isMobile});
  final String lead;
  final String accent;
  final bool isMobile;

  @override
  Widget build(BuildContext context) {
    final t = context.puls;
    final size = isMobile ? 30.0 : 47.0;
    return Column(
      children: [
        Text(
          lead,
          textAlign: TextAlign.center,
          style: TextStyle(
            fontFamily: PulsColors.fontDisplay,
            color: t.text,
            fontSize: size,
            fontWeight: FontWeight.w600,
            height: 1.06,
            letterSpacing: -1.4,
          ),
        ),
        AnimatedGradientText(
          accent,
          style: TextStyle(
            fontFamily: PulsColors.fontDisplay,
            fontSize: size,
            fontWeight: FontWeight.w600,
            fontStyle: FontStyle.italic,
            height: 1.12,
            letterSpacing: -1.4,
          ),
        ),
      ],
    );
  }
}

// ── How it works (3 quick steps) ───────────────────────────────────────────────
class _HowItWorksSection extends StatelessWidget {
  const _HowItWorksSection();

  @override
  Widget build(BuildContext context) {
    final w = MediaQuery.sizeOf(context).width;
    final isMobile = w < 760;
    const steps = [
      (
        Icons.login_rounded,
        '1',
        'Sign in with Google',
        'A Circle MPC wallet is created on Arc instantly — no seed phrase, no extension, no ETH.',
      ),
      (
        Icons.water_drop_rounded,
        '2',
        'Fund with USDC',
        'Claim free USDC. On Arc, USDC is the gas token — one token pays for everything.',
      ),
      (
        Icons.swipe_rounded,
        '3',
        'Swipe to trade',
        'Swipe right for YES, left for NO on any real-world market. Confirms on-chain in under a second.',
      ),
    ];

    return Container(
      padding: EdgeInsets.symmetric(
          horizontal: isMobile ? 16 : 48, vertical: isMobile ? 52 : 96),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 1180),
          child: Column(
            children: [
              const _SectionEyebrow(label: 'HOW IT WORKS'),
              const SizedBox(height: 22),
              _GradientHeadline(
                lead: 'From zero to trading,',
                accent: 'in under a minute.',
                isMobile: isMobile,
              ),
              SizedBox(height: isMobile ? 36 : 64),
              if (isMobile)
                Column(
                  children: [
                    for (var i = 0; i < steps.length; i++) ...[
                      if (i > 0) const SizedBox(height: 14),
                      _HowStep(
                          icon: steps[i].$1,
                          step: steps[i].$2,
                          title: steps[i].$3,
                          body: steps[i].$4),
                    ],
                  ],
                )
              else
                Row(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    for (var i = 0; i < steps.length; i++) ...[
                      if (i > 0) const SizedBox(width: 18),
                      Expanded(
                        child: _HowStep(
                            icon: steps[i].$1,
                            step: steps[i].$2,
                            title: steps[i].$3,
                            body: steps[i].$4),
                      ),
                    ],
                  ],
                ),
            ],
          ),
        ),
      ),
    );
  }
}

class _HowStep extends StatelessWidget {
  const _HowStep(
      {required this.icon,
      required this.step,
      required this.title,
      required this.body});
  final IconData icon;
  final String step;
  final String title;
  final String body;

  @override
  Widget build(BuildContext context) {
    final t = context.puls;
    return Container(
      padding: const EdgeInsets.all(22),
      decoration: BoxDecoration(
        color: t.surface,
        borderRadius: BorderRadius.circular(20),
        border: Border.all(color: t.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              Container(
                width: 44,
                height: 44,
                alignment: Alignment.center,
                decoration: BoxDecoration(
                  gradient: PulsColors.pulseGradient,
                  borderRadius: BorderRadius.circular(13),
                  boxShadow: [
                    BoxShadow(
                        color: t.brand.withValues(alpha: 0.3),
                        blurRadius: 12,
                        offset: const Offset(0, 5)),
                  ],
                ),
                child: Icon(icon, color: Colors.white, size: 23),
              ),
              const Spacer(),
              Text(step,
                  style: TextStyle(
                      fontFamily: PulsColors.fontDisplay,
                      color: t.border,
                      fontSize: 42,
                      fontWeight: FontWeight.w800,
                      height: 1.0)),
            ],
          ),
          const SizedBox(height: 16),
          Text(title,
              style: TextStyle(
                  color: t.text,
                  fontSize: 17,
                  fontWeight: FontWeight.w800,
                  letterSpacing: -0.3)),
          const SizedBox(height: 7),
          Text(body,
              style:
                  TextStyle(color: t.textMuted, fontSize: 13.5, height: 1.55)),
        ],
      ),
    );
  }
}

// ── Bento layout ───────────────────────────────────────────────────────────────
class _Bento extends StatefulWidget {
  const _Bento({required this.scrollOffset});
  final double scrollOffset;

  @override
  State<_Bento> createState() => _BentoState();
}

class _BentoState extends State<_Bento> {
  bool _revealed = false;
  double? _top;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) => _maybeReveal());
  }

  @override
  void didUpdateWidget(covariant _Bento old) {
    super.didUpdateWidget(old);
    if (!_revealed) _maybeReveal();
  }

  void _maybeReveal() {
    if (!mounted || _revealed) return;
    if (context.reduceMotion) {
      setState(() => _revealed = true);
      return;
    }
    final box = context.findRenderObject() as RenderBox?;
    if (box == null || !box.attached || !box.hasSize) return;
    _top = box.localToGlobal(Offset.zero).dy + widget.scrollOffset;
    final h = MediaQuery.sizeOf(context).height;
    if (widget.scrollOffset + h * 0.9 > _top!) {
      setState(() => _revealed = true);
    } else {
      setState(() {}); // keep the measured position for the next scroll tick
    }
  }

  // Staggered entrance per cell once the bento scrolls into view.
  Widget _cell(Widget cell, int i) {
    if (context.reduceMotion) return cell;
    if (!_revealed) return Opacity(opacity: 0, child: cell);
    final delay = (i * 80).ms;
    return cell
        .animate()
        .fadeIn(duration: 460.ms, delay: delay)
        .slideY(begin: 0.14, end: 0, duration: 540.ms, delay: delay, curve: Curves.easeOutCubic);
  }

  @override
  Widget build(BuildContext context) {
    return LayoutBuilder(builder: (context, c) {
      final wide = c.maxWidth >= 900;
      const gap = 18.0;

      // Featured card leads with AgentBond — the core "skin in the game" primitive.
      const hero = _BentoCell(
        accent: Color(0xFFF59E0B),
        featured: true,
        eyebrow: 'AGENTBOND · SKIN IN THE GAME',
        title: 'Every prediction is staked',
        body: 'Each agent backs its call with a real USDC AgentBond, locked on-chain. '
            'Wrong call → bond slashed. Right call → returned, reputation rises. '
            'No cheap talk — reputation is capital at risk.',
        visual: _BondViz(),
      );
      const pay = _BentoCell(
        accent: Color(0xFFEC4899),
        eyebrow: 'x402 · AGENT-TO-AGENT',
        title: 'Pay-per-read intelligence',
        body: 'Agents buy each other\'s Signals via USDC nanopayments '
            'before trading — a closed-loop market for on-chain alpha.',
        visual: _PayFlowViz(),
      );
      const bond = _BentoCell(
        accent: Color(0xFF2DD4BF),
        eyebrow: 'AUTONOMOUS · NO HUMAN IN THE LOOP',
        title: 'Agents that decide, not automate',
        body: 'Pulse researches live sources, reasons with citations, sizes by risk, '
            'and publishes a HOLD when there is no edge. Genuine agency, on-chain.',
        visual: _AgentDecideViz(),
      );
      const signal = _BentoCell(
        accent: Color(0xFF8B5CF6),
        eyebrow: 'CREATOR ECONOMY',
        title: 'Earn per read',
        body: 'Publish a premium Signal, attested on-chain, unlocked '
            'per read in USDC.',
        visual: _SignalUnlockViz(),
      );
      const director = _BentoCell(
        accent: Color(0xFF0EA5E9),
        eyebrow: 'FINANCE DIRECTOR · x402 · PAID',
        title: 'Your AI portfolio manager',
        body: 'Pay in USDC and it reads your whole portfolio, then returns a risk-managed '
            'basket of +EV predicts sized to your balance — money-back if it loses.',
        visual: _DirectorViz(),
      );
      final swipe = _BentoCell(
        accent: const Color(0xFFF472B6),
        eyebrow: 'SUB-SECOND · USDC GAS',
        title: 'Swipe to trade',
        body: 'Right for YES, left for NO — settled on Arc in under a '
            'second. No modal, no ETH, no seed phrase.',
        visual: const _SwipeViz(),
        horizontal: wide,
      );
      final gateway = _BentoCell(
        accent: const Color(0xFF3B82F6),
        eyebrow: 'PULS GATEWAY · x402',
        title: 'Agents buy real-world data',
        body: 'Agents use Circle MPC wallets to purchase verified macro and crypto intel via x402 nanopayments. No hallucination, just verified data.',
        visual: const _GatewayViz(),
        horizontal: wide,
      );

      if (!wide) {
        return Column(
          children: [
            SizedBox(height: 430, child: _cell(hero, 0)),
            const SizedBox(height: gap),
            SizedBox(height: 300, child: _cell(pay, 1)),
            const SizedBox(height: gap),
            SizedBox(height: 280, child: _cell(bond, 2)),
            const SizedBox(height: gap),
            SizedBox(height: 300, child: _cell(signal, 3)),
            const SizedBox(height: gap),
            SizedBox(height: 280, child: _cell(director, 4)),
            const SizedBox(height: gap),
            SizedBox(height: 300, child: _cell(gateway, 5)),
            const SizedBox(height: gap),
            SizedBox(height: 300, child: _cell(swipe, 6)),
          ],
        );
      }

      return Column(
        children: [
          SizedBox(
            height: 384,
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Expanded(flex: 7, child: _cell(hero, 0)),
                const SizedBox(width: gap),
                Expanded(flex: 5, child: _cell(pay, 1)),
              ],
            ),
          ),
          const SizedBox(height: gap),
          SizedBox(
            height: 292,
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Expanded(child: _cell(bond, 2)),
                const SizedBox(width: gap),
                Expanded(child: _cell(signal, 3)),
                const SizedBox(width: gap),
                Expanded(child: _cell(director, 4)),
              ],
            ),
          ),
          const SizedBox(height: gap),
          SizedBox(height: 208, child: _cell(gateway, 5)),
          const SizedBox(height: gap),
          SizedBox(height: 208, child: _cell(swipe, 6)),
        ],
      );
    });
  }
}

class _BentoCell extends StatefulWidget {
  const _BentoCell({
    required this.accent,
    required this.eyebrow,
    required this.title,
    required this.body,
    required this.visual,
    this.featured = false,
    this.horizontal = false,
  });
  final Color accent;
  final String eyebrow;
  final String title;
  final String body;
  final Widget visual;
  final bool featured;
  final bool horizontal;

  @override
  State<_BentoCell> createState() => _BentoCellState();
}

class _BentoCellState extends State<_BentoCell> {
  bool _hovered = false;
  Offset _cursor = Offset.zero;

  Widget _wrapVisual(Widget v) =>
      ClipRect(child: SizedBox.expand(child: RepaintBoundary(child: v)));

  @override
  Widget build(BuildContext context) {
    final t = context.puls;
    final a = widget.accent;

    final text = Column(
      crossAxisAlignment: CrossAxisAlignment.start,
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          widget.eyebrow,
          maxLines: 1,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            color: a,
            fontSize: 10.5,
            fontWeight: FontWeight.w800,
            letterSpacing: 1.3,
          ),
        ),
        const SizedBox(height: 7),
        Text(
          widget.title,
          style: TextStyle(
            color: t.text,
            fontSize: widget.featured ? 23 : 17.5,
            fontWeight: FontWeight.w800,
            letterSpacing: -0.4,
            height: 1.1,
          ),
        ),
        const SizedBox(height: 7),
        Text(
          widget.body,
          maxLines: widget.featured ? 3 : 2,
          overflow: TextOverflow.ellipsis,
          style: TextStyle(
            color: t.textMuted,
            fontSize: widget.featured ? 14.5 : 12.8,
            height: 1.5,
          ),
        ),
      ],
    );

    final Widget content = widget.horizontal
        ? Row(
            children: [
              Expanded(
                flex: 5,
                child: Align(alignment: Alignment.centerLeft, child: text),
              ),
              const SizedBox(width: 12),
              Expanded(flex: 6, child: _wrapVisual(widget.visual)),
            ],
          )
        : Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Expanded(child: _wrapVisual(widget.visual)),
              const SizedBox(height: 14),
              text,
            ],
          );

    final pad = widget.featured ? 24.0 : 20.0;

    return MouseRegion(
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      onHover: (e) {
        if (_hovered) setState(() => _cursor = e.localPosition);
      },
      child: AnimatedContainer(
        duration: const Duration(milliseconds: 220),
        curve: Curves.easeOut,
        transform: _hovered
            ? Matrix4.translationValues(0.0, -4.0, 0.0)
            : Matrix4.identity(),
        decoration: BoxDecoration(
          gradient: LinearGradient(
            begin: Alignment.topLeft,
            end: Alignment.bottomRight,
            colors: [
              t.surface,
              Color.alphaBlend(
                  a.withValues(alpha: widget.featured ? 0.07 : 0.04), t.surface),
            ],
          ),
          borderRadius: BorderRadius.circular(24),
          border: Border.all(
            color: _hovered ? a.withValues(alpha: 0.5) : t.border,
          ),
          boxShadow: _hovered
              ? [
                  BoxShadow(
                      color: a.withValues(alpha: 0.18),
                      blurRadius: 40,
                      offset: const Offset(0, 18))
                ]
              : [
                  BoxShadow(
                      color: t.text.withValues(alpha: 0.05),
                      blurRadius: 18,
                      offset: const Offset(0, 8))
                ],
        ),
        child: ClipRRect(
          borderRadius: BorderRadius.circular(24),
          child: BackdropFilter(
            filter: ImageFilter.blur(sigmaX: 12, sigmaY: 12),
            child: Stack(
              children: [
                if (_hovered)
                  Positioned.fill(
                    child: IgnorePointer(
                      child: CustomPaint(
                        painter: _SpotlightPainter(center: _cursor, color: a),
                      ),
                    ),
                  ),
                Padding(padding: EdgeInsets.all(pad), child: content),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

// Soft accent glow that tracks the cursor — the signature "spotlight card" feel.
class _SpotlightPainter extends CustomPainter {
  const _SpotlightPainter({required this.center, required this.color});
  final Offset center;
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final r = size.longestSide * 0.7;
    final paint = Paint()
      ..shader = RadialGradient(
        colors: [color.withValues(alpha: 0.15), color.withValues(alpha: 0.0)],
      ).createShader(Rect.fromCircle(center: center, radius: r));
    canvas.drawRect(Offset.zero & size, paint);
  }

  @override
  bool shouldRepaint(_SpotlightPainter old) =>
      old.center != center || old.color != color;
}

// ── Visual · Puls Streams pay-per-second meter ─────────────────────────────────
// A live meter accruing USDC every second toward a cap — the "water meter" for
// value. Loops: flow ticks up, settles, resets. Honors reduce-motion.
class _StreamMeterViz extends StatefulWidget {
  const _StreamMeterViz();
  @override
  State<_StreamMeterViz> createState() => _StreamMeterVizState();
}

class _StreamMeterVizState extends State<_StreamMeterViz>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;
  static const _accent = Color(0xFF22D3EE); // cyan — "flow"
  static const _cap = 0.5; // USDC cap shown

  @override
  void initState() {
    super.initState();
    _c = AnimationController(vsync: this, duration: const Duration(seconds: 7));
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final reduce = context.reduceMotion;
    if (reduce) {
      if (_c.isAnimating) _c.stop();
    } else if (!_c.isAnimating) {
      _c.repeat();
    }
    final t = context.puls;
    return AnimatedBuilder(
      animation: _c,
      builder: (context, _) {
        final p = reduce ? 0.62 : _c.value; // 0..1 fill of the meter
        final accrued = _cap * p; // USDC streamed so far
        final secs = accrued / 0.015; // at $0.015/sec
        final on = reduce ? true : (p * 6).floor().isEven; // live pulse
        return Container(
          padding: const EdgeInsets.all(16),
          decoration: BoxDecoration(
            color: t.bg,
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: t.border),
          ),
          child: Column(
            mainAxisAlignment: MainAxisAlignment.center,
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Container(
                    width: 7,
                    height: 7,
                    decoration: BoxDecoration(
                      color: on ? _accent : _accent.withValues(alpha: 0.3),
                      shape: BoxShape.circle,
                      boxShadow: on
                          ? [
                              BoxShadow(
                                  color: _accent.withValues(alpha: 0.6),
                                  blurRadius: 6)
                            ]
                          : null,
                    ),
                  ),
                  const SizedBox(width: 7),
                  Text('STREAMING · live-alpha',
                      style: TextStyle(
                          color: t.textSubtle,
                          fontSize: 9.5,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 1.1)),
                  const Spacer(),
                  const Text('\$0.015/s',
                      style: TextStyle(
                          color: _accent,
                          fontSize: 10.5,
                          fontWeight: FontWeight.w800)),
                ],
              ),
              const SizedBox(height: 12),
              Text('\$${accrued.toStringAsFixed(3)}',
                  style: TextStyle(
                      color: t.text,
                      fontSize: 30,
                      fontWeight: FontWeight.w900,
                      letterSpacing: -1)),
              const SizedBox(height: 2),
              Text('${secs.toStringAsFixed(0)}s · settled in USDC on Arc',
                  style: TextStyle(color: t.textMuted, fontSize: 11)),
              const SizedBox(height: 12),
              ClipRRect(
                borderRadius: BorderRadius.circular(100),
                child: LinearProgressIndicator(
                  value: p,
                  minHeight: 7,
                  backgroundColor: t.border,
                  valueColor: const AlwaysStoppedAnimation(_accent),
                ),
              ),
              const SizedBox(height: 6),
              Row(
                mainAxisAlignment: MainAxisAlignment.spaceBetween,
                children: [
                  Text('rate × time',
                      style: TextStyle(
                          color: t.textSubtle,
                          fontSize: 9.5,
                          fontWeight: FontWeight.w700)),
                  Text('cap \$${_cap.toStringAsFixed(2)}',
                      style: TextStyle(
                          color: t.textSubtle,
                          fontSize: 9.5,
                          fontWeight: FontWeight.w700)),
                ],
              ),
            ],
          ),
        );
      },
    );
  }
}

// ── Visual 1 · the flagship decision engine ────────────────────────────────────
class _AgentDecideViz extends StatefulWidget {
  const _AgentDecideViz();
  @override
  State<_AgentDecideViz> createState() => _AgentDecideVizState();
}

class _AgentDecideVizState extends State<_AgentDecideViz>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;
  static const _sources = ['Reuters', 'Polymarket', 'On-chain'];

  @override
  void initState() {
    super.initState();
    _c = AnimationController(vsync: this, duration: const Duration(seconds: 12));
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final reduce = context.reduceMotion;
    if (reduce) {
      if (_c.isAnimating) _c.stop();
    } else if (!_c.isAnimating) {
      _c.repeat();
    }
    return AnimatedBuilder(
      animation: _c,
      builder: (context, _) {
        final raw = reduce ? 0.85 : _c.value;
        final yes = raw < 0.5; // first half BUY YES, second half HOLD
        final localT = reduce ? 0.85 : (raw % 0.5) / 0.5;
        return _frame(context, localT, yes);
      },
    );
  }

  Widget _frame(BuildContext context, double localT, bool yes) {
    final t = context.puls;
    final confTarget = yes ? 0.78 : 0.46;
    final confFactor =
        Curves.easeOut.transform(((localT - 0.28) / 0.34).clamp(0.0, 1.0));
    final conf = confFactor * confTarget;
    final pct = (conf * 100).round();
    final showVerdict = localT > 0.66;
    final verdictColor = yes ? t.yes : PulsColors.amber;

    return Container(
      padding: const EdgeInsets.all(14),
      decoration: BoxDecoration(
        color: t.bg.withValues(alpha: 0.45),
        borderRadius: BorderRadius.circular(16),
        border: Border.all(color: t.border),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Row(
            children: [
              _glowDot(t.yes),
              const SizedBox(width: 7),
              Text('SCANNING SOURCES',
                  style: TextStyle(
                      color: t.textSubtle,
                      fontSize: 9.5,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 1.0)),
            ],
          ),
          const SizedBox(height: 11),
          Wrap(
            spacing: 6,
            runSpacing: 6,
            children: [
              for (var i = 0; i < _sources.length; i++)
                _sourceChip(t, _sources[i],
                    ((localT - i * 0.09) / 0.12).clamp(0.0, 1.0)),
            ],
          ),
          const Spacer(),
          Row(
            children: [
              Text('CONFIDENCE',
                  style: TextStyle(
                      color: t.textSubtle,
                      fontSize: 9.5,
                      fontWeight: FontWeight.w800,
                      letterSpacing: 1.0)),
              const Spacer(),
              Text('$pct%',
                  style: TextStyle(
                      color: t.text,
                      fontSize: 12,
                      fontWeight: FontWeight.w800,
                      fontFeatures: const [FontFeature.tabularFigures()])),
            ],
          ),
          const SizedBox(height: 7),
          SizedBox(
            width: double.infinity,
            child: ClipRRect(
              borderRadius: BorderRadius.circular(100),
              child: Stack(
                children: [
                  Container(height: 7, color: t.surfaceRaised),
                  FractionallySizedBox(
                    widthFactor: conf.clamp(0.0, 1.0),
                    child: Container(
                      height: 7,
                      decoration:
                          const BoxDecoration(gradient: PulsColors.pulseGradient),
                    ),
                  ),
                ],
              ),
            ),
          ),
          const SizedBox(height: 12),
          AnimatedOpacity(
            duration: const Duration(milliseconds: 220),
            opacity: showVerdict ? 1 : 0,
            child: Row(
              children: [
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 10, vertical: 6),
                  decoration: BoxDecoration(
                    color: verdictColor.withValues(alpha: 0.14),
                    borderRadius: BorderRadius.circular(9),
                    border:
                        Border.all(color: verdictColor.withValues(alpha: 0.42)),
                  ),
                  child: Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      Icon(
                          yes
                              ? Icons.trending_up_rounded
                              : Icons.pause_rounded,
                          size: 14,
                          color: verdictColor),
                      const SizedBox(width: 5),
                      Text(yes ? 'BUY YES' : 'HOLD',
                          style: TextStyle(
                              color: verdictColor,
                              fontSize: 12,
                              fontWeight: FontWeight.w800)),
                    ],
                  ),
                ),
                const SizedBox(width: 9),
                Flexible(
                  child: Text(yes ? 'sized to bankroll' : 'no +EV edge',
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(color: t.textSubtle, fontSize: 11)),
                ),
              ],
            ),
          ),
        ],
      ),
    );
  }

  Widget _glowDot(Color c) => Container(
        width: 6,
        height: 6,
        decoration: BoxDecoration(
          color: c,
          shape: BoxShape.circle,
          boxShadow: [BoxShadow(color: c.withValues(alpha: 0.6), blurRadius: 5)],
        ),
      );

  Widget _sourceChip(PulsThemeColors t, String label, double lit) {
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
      decoration: BoxDecoration(
        color: Color.alphaBlend(t.brand.withValues(alpha: 0.10 * lit), t.surface),
        borderRadius: BorderRadius.circular(8),
        border: Border.all(color: t.brand.withValues(alpha: 0.12 + 0.3 * lit)),
      ),
      child: Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.check_circle_rounded,
              size: 11, color: t.brand.withValues(alpha: 0.35 + 0.65 * lit)),
          const SizedBox(width: 5),
          Text(label,
              style: TextStyle(
                  color: t.text.withValues(alpha: 0.5 + 0.5 * lit),
                  fontSize: 11,
                  fontWeight: FontWeight.w600)),
        ],
      ),
    );
  }
}

// ── Visual 2 · agent-to-agent x402 payment ─────────────────────────────────────
class _PayFlowViz extends StatefulWidget {
  const _PayFlowViz();
  @override
  State<_PayFlowViz> createState() => _PayFlowVizState();
}

class _PayFlowVizState extends State<_PayFlowViz>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;

  @override
  void initState() {
    super.initState();
    _c = AnimationController(
        vsync: this, duration: const Duration(milliseconds: 2800));
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final reduce = context.reduceMotion;
    if (reduce) {
      if (_c.isAnimating) _c.stop();
    } else if (!_c.isAnimating) {
      _c.repeat();
    }
    final t = context.puls;
    return AnimatedBuilder(
      animation: _c,
      builder: (context, _) {
        final v = reduce ? 0.5 : _c.value;
        final travel =
            Curves.easeInOut.transform(((v - 0.08) / 0.62).clamp(0.0, 1.0));
        final arrived = !reduce && v > 0.72 && v < 0.99;
        return Column(
          children: [
            Expanded(
              child: Stack(
                children: [
                  Center(
                    child: Row(
                      children: [
                        _node(t, const Color(0xFF2DD4BF),
                            Icons.smart_toy_rounded, 'Pulse', false),
                        Expanded(
                          child: Container(
                            height: 2,
                            margin: const EdgeInsets.symmetric(horizontal: 6),
                            decoration: BoxDecoration(
                              color: t.border,
                              borderRadius: BorderRadius.circular(2),
                            ),
                          ),
                        ),
                        _node(t, const Color(0xFFEC4899),
                            Icons.auto_awesome_rounded, 'Sage', arrived),
                      ],
                    ),
                  ),
                  Positioned.fill(
                    child: Padding(
                      padding: const EdgeInsets.symmetric(horizontal: 54),
                      child: Align(
                        alignment: Alignment(travel * 2 - 1, -0.32),
                        child: _coin(),
                      ),
                    ),
                  ),
                ],
              ),
            ),
            const SizedBox(height: 6),
            AnimatedContainer(
              duration: const Duration(milliseconds: 200),
              padding: const EdgeInsets.symmetric(horizontal: 11, vertical: 6),
              decoration: BoxDecoration(
                color: arrived
                    ? const Color(0xFFEC4899).withValues(alpha: 0.14)
                    : t.surfaceRaised,
                borderRadius: BorderRadius.circular(9),
                border: Border.all(
                    color: arrived
                        ? const Color(0xFFEC4899).withValues(alpha: 0.42)
                        : t.border),
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                children: [
                  const Icon(Icons.bolt_rounded,
                      size: 13, color: Color(0xFFEC4899)),
                  const SizedBox(width: 5),
                  Text('x402 · 0.001 USDC',
                      style: TextStyle(
                          color: t.text,
                          fontSize: 11.5,
                          fontWeight: FontWeight.w700)),
                ],
              ),
            ),
          ],
        );
      },
    );
  }

  Widget _node(PulsThemeColors t, Color c, IconData icon, String label,
          bool pulse) =>
      Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          AnimatedScale(
            scale: pulse ? 1.14 : 1.0,
            duration: const Duration(milliseconds: 220),
            child: Container(
              width: 46,
              height: 46,
              alignment: Alignment.center,
              decoration: BoxDecoration(
                gradient: LinearGradient(
                  begin: Alignment.topLeft,
                  end: Alignment.bottomRight,
                  colors: [
                    c,
                    Color.alphaBlend(Colors.white.withValues(alpha: 0.4), c)
                  ],
                ),
                borderRadius: BorderRadius.circular(14),
                boxShadow: [
                  BoxShadow(
                      color: c.withValues(alpha: pulse ? 0.5 : 0.3),
                      blurRadius: pulse ? 18 : 12,
                      offset: const Offset(0, 6))
                ],
              ),
              child: Icon(icon, color: Colors.white, size: 24),
            ),
          ),
          const SizedBox(height: 7),
          Text(label,
              style: TextStyle(
                  color: t.textMuted,
                  fontSize: 10.5,
                  fontWeight: FontWeight.w700)),
        ],
      );

  Widget _coin() => Container(
        width: 30,
        height: 30,
        alignment: Alignment.center,
        decoration: BoxDecoration(
          shape: BoxShape.circle,
          gradient: PulsColors.pulseGradient,
          boxShadow: [
            BoxShadow(
                color: const Color(0xFFF65FA9).withValues(alpha: 0.5),
                blurRadius: 12,
                offset: const Offset(0, 4))
          ],
        ),
        child: const Text('\$',
            style: TextStyle(
                color: Colors.white, fontSize: 15, fontWeight: FontWeight.w800)),
      );
}

// ── Visual 3 · AgentBond stake / slash ─────────────────────────────────────────
class _BondViz extends StatefulWidget {
  const _BondViz();
  @override
  State<_BondViz> createState() => _BondVizState();
}

class _BondVizState extends State<_BondViz>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;

  @override
  void initState() {
    super.initState();
    _c = AnimationController(vsync: this, duration: const Duration(seconds: 9));
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final reduce = context.reduceMotion;
    if (reduce) {
      if (_c.isAnimating) _c.stop();
    } else if (!_c.isAnimating) {
      _c.repeat();
    }
    final t = context.puls;
    return AnimatedBuilder(
      animation: _c,
      builder: (context, _) {
        final v = reduce ? 0.3 : _c.value;
        final win = v < 0.5; // alternate: returned, then slashed
        final localT = reduce ? 0.3 : (v % 0.5) / 0.5;
        final fill =
            Curves.easeOut.transform((localT / 0.45).clamp(0.0, 1.0));
        final resolved = localT > 0.55;
        final displayFill = !resolved
            ? fill
            : win
                ? 1.0
                : 1.0 -
                    Curves.easeIn
                        .transform(((localT - 0.55) / 0.32).clamp(0.0, 1.0));
        final Color barColor = !resolved
            ? PulsColors.amber
            : win
                ? t.yes
                : t.no;
        final label = !resolved
            ? 'STAKED'
            : win
                ? 'RETURNED'
                : 'SLASHED';
        final icon = !resolved
            ? Icons.lock_rounded
            : win
                ? Icons.verified_rounded
                : Icons.gpp_bad_rounded;

        return Column(
          mainAxisAlignment: MainAxisAlignment.center,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  width: 42,
                  height: 42,
                  alignment: Alignment.center,
                  decoration: BoxDecoration(
                    color: barColor.withValues(alpha: 0.14),
                    borderRadius: BorderRadius.circular(13),
                    border: Border.all(color: barColor.withValues(alpha: 0.4)),
                  ),
                  child: Icon(icon, color: barColor, size: 21),
                ),
                const SizedBox(width: 11),
                Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text('1.0 USDC bond',
                        style: TextStyle(
                            color: t.text,
                            fontSize: 13.5,
                            fontWeight: FontWeight.w800)),
                    const SizedBox(height: 2),
                    Text('on this call',
                        style:
                            TextStyle(color: t.textSubtle, fontSize: 11)),
                  ],
                ),
              ],
            ),
            const SizedBox(height: 16),
            SizedBox(
              width: double.infinity,
              child: ClipRRect(
                borderRadius: BorderRadius.circular(100),
                child: Stack(
                  children: [
                    Container(height: 8, color: t.surfaceRaised),
                    FractionallySizedBox(
                      widthFactor: displayFill.clamp(0.0, 1.0),
                      child: Container(height: 8, color: barColor),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(height: 12),
            Row(
              children: [
                Container(
                  padding:
                      const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
                  decoration: BoxDecoration(
                    color: barColor.withValues(alpha: 0.14),
                    borderRadius: BorderRadius.circular(8),
                  ),
                  child: Text(label,
                      style: TextStyle(
                          color: barColor,
                          fontSize: 11,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 0.6)),
                ),
                const Spacer(),
                Text('reputation = capital',
                    style: TextStyle(color: t.textSubtle, fontSize: 10.5)),
              ],
            ),
          ],
        );
      },
    );
  }
}

// ── Visual 4 · creator Signal unlock ───────────────────────────────────────────
class _SignalUnlockViz extends StatefulWidget {
  const _SignalUnlockViz();
  @override
  State<_SignalUnlockViz> createState() => _SignalUnlockVizState();
}

class _SignalUnlockVizState extends State<_SignalUnlockViz>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;

  @override
  void initState() {
    super.initState();
    _c = AnimationController(
        vsync: this, duration: const Duration(milliseconds: 4200));
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final reduce = context.reduceMotion;
    if (reduce) {
      if (_c.isAnimating) _c.stop();
    } else if (!_c.isAnimating) {
      _c.repeat();
    }
    final t = context.puls;
    const purple = Color(0xFF8B5CF6);
    return AnimatedBuilder(
      animation: _c,
      builder: (context, _) {
        final v = reduce ? 0.8 : _c.value;
        final u = ((v - 0.42) / 0.2).clamp(0.0, 1.0); // unlock progress
        final earn = ((v - 0.58) / 0.32).clamp(0.0, 1.0); // +USDC float
        final unlocked = u > 0.5;

        return Stack(
          children: [
            // The premium Signal "behind the paywall".
            Container(
              padding: const EdgeInsets.all(14),
              decoration: BoxDecoration(
                color: t.bg.withValues(alpha: 0.5),
                borderRadius: BorderRadius.circular(16),
                border: Border.all(color: t.border),
              ),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Row(
                    children: [
                      Container(
                        padding: const EdgeInsets.symmetric(
                            horizontal: 7, vertical: 3),
                        decoration: BoxDecoration(
                          color: purple.withValues(alpha: 0.14),
                          borderRadius: BorderRadius.circular(6),
                        ),
                        child: const Text('SIGNAL',
                            style: TextStyle(
                                color: purple,
                                fontSize: 9,
                                fontWeight: FontWeight.w800,
                                letterSpacing: 0.8)),
                      ),
                      const Spacer(),
                      Icon(Icons.verified_rounded,
                          size: 13, color: t.textSubtle),
                    ],
                  ),
                  const SizedBox(height: 11),
                  _bar(t, 0.92),
                  const SizedBox(height: 7),
                  _bar(t, 0.7),
                  const SizedBox(height: 7),
                  _bar(t, 0.8),
                ],
              ),
            ),
            // Frosted lock overlay that lifts as it unlocks.
            Positioned.fill(
              child: IgnorePointer(
                child: Opacity(
                  opacity: 1 - u,
                  child: Container(
                    alignment: Alignment.center,
                    decoration: BoxDecoration(
                      color: t.surface.withValues(alpha: 0.82),
                      borderRadius: BorderRadius.circular(16),
                      border:
                          Border.all(color: purple.withValues(alpha: 0.25)),
                    ),
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        const Icon(Icons.lock_rounded, size: 22, color: purple),
                        const SizedBox(height: 6),
                        Text('UNLOCK · \$0.50',
                            style: TextStyle(
                                color: t.text,
                                fontSize: 12,
                                fontWeight: FontWeight.w800)),
                      ],
                    ),
                  ),
                ),
              ),
            ),
            // Earnings receipt rising to the creator.
            if (unlocked)
              Positioned(
                top: 8 + (1 - earn) * 12,
                right: 12,
                child: Opacity(
                  opacity: (earn < 0.85 ? earn : (1 - earn) / 0.15)
                      .clamp(0.0, 1.0),
                  child: Container(
                    padding: const EdgeInsets.symmetric(
                        horizontal: 9, vertical: 5),
                    decoration: BoxDecoration(
                      color: t.yes.withValues(alpha: 0.16),
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: t.yes.withValues(alpha: 0.4)),
                    ),
                    child: Text('+\$0.50 USDC',
                        style: TextStyle(
                            color: t.yes,
                            fontSize: 11.5,
                            fontWeight: FontWeight.w800)),
                  ),
                ),
              ),
          ],
        );
      },
    );
  }

  Widget _bar(PulsThemeColors t, double factor) => Align(
        alignment: Alignment.centerLeft,
        child: FractionallySizedBox(
          widthFactor: factor,
          child: Container(
            height: 8,
            decoration: BoxDecoration(
              color: t.surfaceRaised,
              borderRadius: BorderRadius.circular(100),
            ),
          ),
        ),
      );
}

// ── Visual 5 · Finance Director portfolio basket ───────────────────────────────
class _DirectorViz extends StatefulWidget {
  const _DirectorViz();
  @override
  State<_DirectorViz> createState() => _DirectorVizState();
}

class _DirectorVizState extends State<_DirectorViz>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;

  // A tiny risk-managed basket: tier, side, question, size%, tier colour.
  static const _picks = <(String, String, String, int, Color)>[
    ('CORE', 'YES', 'Fed cuts rates in July', 52, Color(0xFF16A34A)),
    ('HEDGE', 'NO', 'BTC ETF inflows top \$1B', 30, Color(0xFF8B5CF6)),
  ];

  @override
  void initState() {
    super.initState();
    _c = AnimationController(vsync: this, duration: const Duration(seconds: 6));
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final reduce = context.reduceMotion;
    if (reduce) {
      if (_c.isAnimating) _c.stop();
    } else if (!_c.isAnimating) {
      _c.repeat();
    }
    final t = context.puls;
    return AnimatedBuilder(
      animation: _c,
      builder: (context, _) {
        final v = reduce ? 1.0 : _c.value;
        return Container(
          padding: const EdgeInsets.all(13),
          decoration: BoxDecoration(
            color: t.bg.withValues(alpha: 0.45),
            borderRadius: BorderRadius.circular(16),
            border: Border.all(color: t.border),
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Row(
                children: [
                  Text('PORTFOLIO PLAN',
                      style: TextStyle(
                          color: t.textSubtle,
                          fontSize: 9.5,
                          fontWeight: FontWeight.w800,
                          letterSpacing: 1.0)),
                  const Spacer(),
                  Text('\$42 bankroll',
                      style: TextStyle(
                          color: t.textMuted,
                          fontSize: 10.5,
                          fontWeight: FontWeight.w700)),
                ],
              ),
              const SizedBox(height: 10),
              for (var i = 0; i < _picks.length; i++)
                Padding(
                  padding:
                      EdgeInsets.only(bottom: i == _picks.length - 1 ? 0 : 7),
                  child: _pickRow(
                      t, _picks[i], ((v - i * 0.2) / 0.3).clamp(0.0, 1.0)),
                ),
              const Spacer(),
              const SizedBox(height: 10),
              Row(
                children: [
                  Container(
                    padding:
                        const EdgeInsets.symmetric(horizontal: 9, vertical: 5),
                    decoration: BoxDecoration(
                      color: t.yes.withValues(alpha: 0.14),
                      borderRadius: BorderRadius.circular(8),
                      border: Border.all(color: t.yes.withValues(alpha: 0.4)),
                    ),
                    child: Row(
                      mainAxisSize: MainAxisSize.min,
                      children: [
                        Icon(Icons.verified_user_rounded,
                            size: 12, color: t.yes),
                        const SizedBox(width: 5),
                        Text('money-back if it loses',
                            style: TextStyle(
                                color: t.yes,
                                fontSize: 10.5,
                                fontWeight: FontWeight.w800)),
                      ],
                    ),
                  ),
                  const Spacer(),
                  Text('paid · \$0.50',
                      style: TextStyle(color: t.textSubtle, fontSize: 10.5)),
                ],
              ),
            ],
          ),
        );
      },
    );
  }

  Widget _pickRow(PulsThemeColors t, (String, String, String, int, Color) pick,
      double lit) {
    final tier = pick.$1;
    final side = pick.$2;
    final question = pick.$3;
    final pct = pick.$4;
    final tierColor = pick.$5;
    final sideColor = side == 'YES' ? t.yes : t.no;
    return Opacity(
      opacity: (0.35 + 0.65 * lit).clamp(0.0, 1.0),
      child: Container(
        padding: const EdgeInsets.symmetric(horizontal: 9, vertical: 8),
        decoration: BoxDecoration(
          color: t.surface,
          borderRadius: BorderRadius.circular(10),
          border: Border.all(color: t.border),
        ),
        child: Row(
          children: [
            _tag(tier, tierColor),
            const SizedBox(width: 5),
            _tag(side, sideColor),
            const SizedBox(width: 8),
            Expanded(
              child: Text(question,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: TextStyle(
                      color: t.text,
                      fontSize: 11,
                      fontWeight: FontWeight.w600)),
            ),
            const SizedBox(width: 8),
            Text('$pct%',
                style: TextStyle(
                    color: t.brand,
                    fontSize: 10.5,
                    fontWeight: FontWeight.w800,
                    fontFeatures: const [FontFeature.tabularFigures()])),
          ],
        ),
      ),
    );
  }

  Widget _tag(String label, Color c) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 5, vertical: 2),
        decoration: BoxDecoration(
          color: c.withValues(alpha: 0.15),
          borderRadius: BorderRadius.circular(5),
        ),
        child: Text(label,
            style: TextStyle(
                color: c,
                fontSize: 8,
                fontWeight: FontWeight.w800,
                letterSpacing: 0.4)),
      );
}

// ── Visual 6 · swipe-to-trade ──────────────────────────────────────────────────
class _SwipeViz extends StatefulWidget {
  const _SwipeViz();
  @override
  State<_SwipeViz> createState() => _SwipeVizState();
}

class _SwipeVizState extends State<_SwipeViz>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;

  @override
  void initState() {
    super.initState();
    _c = AnimationController(
        vsync: this, duration: const Duration(milliseconds: 3600));
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final reduce = context.reduceMotion;
    if (reduce) {
      if (_c.isAnimating) _c.stop();
    } else if (!_c.isAnimating) {
      _c.repeat();
    }
    final t = context.puls;
    return AnimatedBuilder(
      animation: _c,
      builder: (context, _) {
        final v = reduce ? 0.0 : _c.value;
        final yes = v < 0.5; // alternate YES (right) / NO (left)
        final localT = (v % 0.5) / 0.5;
        final progress =
            Curves.easeInOut.transform((localT / 0.62).clamp(0.0, 1.0));
        final dir = yes ? 1.0 : -1.0;
        final dx = reduce ? 0.0 : dir * progress * 52;
        final rot = reduce ? 0.0 : dir * progress * 0.16;
        final stamp =
            reduce ? 0.0 : ((progress - 0.25) / 0.3).clamp(0.0, 1.0);
        final stampColor = yes ? t.yes : t.no;

        return Stack(
          alignment: Alignment.center,
          children: [
            Align(
              alignment: Alignment.centerLeft,
              child: _hint(t, Icons.arrow_back_rounded, 'NO', t.no),
            ),
            Align(
              alignment: Alignment.centerRight,
              child: _hint(t, Icons.arrow_forward_rounded, 'YES', t.yes),
            ),
            Transform.translate(
              offset: Offset(dx, -6 * progress),
              child: Transform.rotate(
                angle: rot,
                child: Stack(
                  clipBehavior: Clip.none,
                  alignment: Alignment.topCenter,
                  children: [
                    _card(t),
                    Positioned(
                      top: 14,
                      child: Opacity(
                        opacity: stamp,
                        child: Transform.rotate(
                          angle: -0.22,
                          child: Container(
                            padding: const EdgeInsets.symmetric(
                                horizontal: 12, vertical: 6),
                            decoration: BoxDecoration(
                              color: stampColor.withValues(alpha: 0.16),
                              borderRadius: BorderRadius.circular(9),
                              border: Border.all(
                                  color: stampColor, width: 2.2),
                            ),
                            child: Text(yes ? 'YES' : 'NO',
                                style: TextStyle(
                                    color: stampColor,
                                    fontSize: 17,
                                    fontWeight: FontWeight.w900,
                                    letterSpacing: 1.5)),
                          ),
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
          ],
        );
      },
    );
  }

  Widget _hint(PulsThemeColors t, IconData icon, String label, Color c) =>
      Column(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(icon, size: 16, color: c.withValues(alpha: 0.5)),
          const SizedBox(height: 3),
          Text(label,
              style: TextStyle(
                  color: c.withValues(alpha: 0.5),
                  fontSize: 10,
                  fontWeight: FontWeight.w800,
                  letterSpacing: 0.8)),
        ],
      );

  Widget _card(PulsThemeColors t) => Container(
        width: 172,
        padding: const EdgeInsets.all(13),
        decoration: BoxDecoration(
          color: t.surface,
          borderRadius: BorderRadius.circular(16),
          border: Border.all(color: t.border),
          boxShadow: [
            BoxShadow(
                color: Colors.black.withValues(alpha: 0.12),
                blurRadius: 20,
                offset: const Offset(0, 8))
          ],
        ),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Container(
                  width: 5,
                  height: 5,
                  decoration:
                      BoxDecoration(color: t.yes, shape: BoxShape.circle),
                ),
                const SizedBox(width: 5),
                Text('LIVE',
                    style: TextStyle(
                        color: t.yes,
                        fontSize: 8.5,
                        fontWeight: FontWeight.w800,
                        letterSpacing: 0.8)),
              ],
            ),
            const SizedBox(height: 9),
            Text('Fed cuts rates in July?',
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: TextStyle(
                    color: t.text,
                    fontSize: 13,
                    fontWeight: FontWeight.w700,
                    height: 1.25)),
            const SizedBox(height: 11),
            Row(
              crossAxisAlignment: CrossAxisAlignment.end,
              children: [
                Text('63¢',
                    style: TextStyle(
                        fontFamily: PulsColors.fontDisplay,
                        color: t.brand,
                        fontSize: 26,
                        fontWeight: FontWeight.w700,
                        height: 1)),
                const SizedBox(width: 5),
                Padding(
                  padding: const EdgeInsets.only(bottom: 3),
                  child: Text('YES',
                      style: TextStyle(
                          color: t.textSubtle,
                          fontSize: 10,
                          fontWeight: FontWeight.w700)),
                ),
              ],
            ),
            const SizedBox(height: 9),
            ClipRRect(
              borderRadius: BorderRadius.circular(100),
              child: SizedBox(
                height: 6,
                child: Row(
                  children: [
                    Expanded(flex: 63, child: Container(color: t.yes)),
                    Expanded(
                        flex: 37,
                        child: Container(
                            color: t.no.withValues(alpha: 0.65))),
                  ],
                ),
              ),
            ),
          ],
        ),
      );
}

// ── Capability strip — breadth without an icon wall ────────────────────────────
class _CapabilityStrip extends StatelessWidget {
  const _CapabilityStrip();

  static const _items = [
    (Icons.account_balance_wallet_rounded, 'Gasless Circle wallet'),
    (Icons.gavel_rounded, 'UMA oracle resolution'),
    (Icons.tune_rounded, 'Limit orders'),
    (Icons.sell_rounded, 'Sell anytime'),
    (Icons.insights_rounded, 'AI Oracle panel'),
    (Icons.notifications_active_rounded, 'Push alerts'),
    (Icons.card_giftcard_rounded, 'Referral rewards'),
    (Icons.emoji_events_rounded, 'Points & quests'),
  ];

  @override
  Widget build(BuildContext context) {
    final t = context.puls;
    return Column(
      children: [
        Text('AND EVERYTHING YOU\'D EXPECT',
            style: TextStyle(
                color: t.textSubtle,
                fontSize: 10.5,
                fontWeight: FontWeight.w800,
                letterSpacing: 2)),
        const SizedBox(height: 18),
        Wrap(
          alignment: WrapAlignment.center,
          spacing: 10,
          runSpacing: 10,
          children: [for (final it in _items) _pill(t, it.$1, it.$2)],
        ),
      ],
    );
  }

  Widget _pill(PulsThemeColors t, IconData icon, String label) => Container(
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 9),
        decoration: BoxDecoration(
          color: t.surface,
          borderRadius: BorderRadius.circular(100),
          border: Border.all(color: t.border),
        ),
        child: Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 14, color: t.brand),
            const SizedBox(width: 7),
            Text(label,
                style: TextStyle(
                    color: t.textMuted,
                    fontSize: 12.5,
                    fontWeight: FontWeight.w600)),
          ],
        ),
      );
}

// ── Stats Section ─────────────────────────────────────────────────────────────
class _StatsSection extends StatelessWidget {
  const _StatsSection();

  @override
  Widget build(BuildContext context) {
    final t = context.puls;
    final w = MediaQuery.sizeOf(context).width;
    final isMobile = w < 600;

    return Container(
      padding: EdgeInsets.symmetric(horizontal: isMobile ? 16 : 48, vertical: isMobile ? 48 : 88),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 960),
          child: Column(
            children: [
              Text(
                'Built on Circle\'s full stack',
                textAlign: TextAlign.center,
                style: TextStyle(color: t.text, fontSize: isMobile ? 24 : 36, fontWeight: FontWeight.w800, letterSpacing: -1),
              ),
              const SizedBox(height: 8),
              Text(
                'Real bonds. Real trades. Real accountability.',
                textAlign: TextAlign.center,
                style: TextStyle(color: t.textMuted, fontSize: isMobile ? 14 : 16),
              ),
              SizedBox(height: isMobile ? 32 : 48),
              LayoutBuilder(builder: (context, constraints) {
                final cols = constraints.maxWidth > 700 ? 4 : 2;
                return Wrap(
                  spacing: isMobile ? 12 : 20, runSpacing: isMobile ? 12 : 20,
                  children: [
                    _statCard('100+', 'Live Markets', 'From Polymarket Gamma API', t.brand, 'https://img.icons8.com/?id=KslJGdGlJFNz&format=png&size=256', constraints, cols, t),
                    _statCard('< 1s', 'Trade Speed', 'Arc sub-second finality', t.yes, 'https://img.icons8.com/?id=XTqUA8keYxec&format=png&size=256', constraints, cols, t),
                    _statCard('\$0 ETH', 'Gas Cost', 'USDC is the native gas token', PulsColors.amber, 'https://img.icons8.com/?id=rcnetj6T68lY&format=png&size=256', constraints, cols, t),
                    _statCard('MPC', 'Wallet Type', 'Circle developer-controlled wallets', const Color(0xFF0EA5E9), 'https://img.icons8.com/?id=hkkfYNNRoACe&format=png&size=256', constraints, cols, t),
                  ],
                );
              }),
              SizedBox(height: isMobile ? 32 : 52),
              // Contract address widget
              GlassCard(
                radius: 16,
                blur: 10,
                fillAlpha: 0.05,
                borderAlpha: 0.12,
                padding: EdgeInsets.all(isMobile ? 14 : 22),
                child: isMobile
                    ? Column(
                        crossAxisAlignment: CrossAxisAlignment.start,
                        children: [
                          Row(
                            children: [
                              Container(
                                width: 36, height: 36,
                                decoration: BoxDecoration(color: t.brandSubtle, borderRadius: BorderRadius.circular(10)),
                                child: Icon(Icons.code_rounded, color: t.brand, size: 18),
                              ),
                              const SizedBox(width: 12),
                              Expanded(
                                child: Text(
                                  'LMSRMarketFactory.sol',
                                  style: TextStyle(color: t.text, fontSize: 13, fontWeight: FontWeight.w700),
                                ),
                              ),
                              const SizedBox(width: 8),
                              const _VerifiedBadge(),
                            ],
                          ),
                          const SizedBox(height: 12),
                          Text(
                            factoryAddress,
                            style: TextStyle(
                              color: t.textSubtle,
                              fontSize: 10,
                              fontFamily: 'monospace',
                              fontFeatures: const [FontFeature.tabularFigures()],
                            ),
                            overflow: TextOverflow.ellipsis,
                          ),
                          const SizedBox(height: 12),
                          Row(
                            children: [
                              const _CopyButton(text: factoryAddress),
                              const SizedBox(width: 8),
                              _SecondaryButton(
                                label: 'View ↗',
                                onTap: () => launchUrl(
                                  Uri.parse('https://testnet.arcscan.app/address/$factoryAddress'),
                                  mode: LaunchMode.externalApplication,
                                ),
                                small: true,
                              ),
                            ],
                          ),
                        ],
                      )
                    : Row(
                        children: [
                          Container(
                            width: 40, height: 40,
                            decoration: BoxDecoration(color: t.brandSubtle, borderRadius: BorderRadius.circular(10)),
                            child: Icon(Icons.code_rounded, color: t.brand, size: 20),
                          ),
                          const SizedBox(width: 16),
                          Expanded(
                            child: Column(
                              crossAxisAlignment: CrossAxisAlignment.start,
                              children: [
                                Row(
                                  children: [
                                    Flexible(
                                      child: Text(
                                        'LMSRMarketFactory.sol — Arc',
                                        style: TextStyle(color: t.text, fontSize: 15, fontWeight: FontWeight.w700),
                                        overflow: TextOverflow.ellipsis,
                                      ),
                                    ),
                                    const SizedBox(width: 10),
                                    const _VerifiedBadge(),
                                  ],
                                ),
                                const SizedBox(height: 4),
                                Text(
                                  factoryAddress,
                                  style: TextStyle(
                                    color: t.textSubtle,
                                    fontSize: 12,
                                    fontFamily: 'monospace',
                                    fontFeatures: const [FontFeature.tabularFigures()],
                                  ),
                                ),
                              ],
                            ),
                          ),
                          const SizedBox(width: 12),
                          const _CopyButton(text: factoryAddress),
                          const SizedBox(width: 8),
                          _SecondaryButton(
                            label: 'View ↗',
                            onTap: () => launchUrl(
                              Uri.parse('https://testnet.arcscan.app/address/$factoryAddress'),
                              mode: LaunchMode.externalApplication,
                            ),
                            small: true,
                          ),
                        ],
                      ),
              ),
            ],
          ),
        ),
      ),
    );
  }

  Widget _statCard(String value, String label, String sub, Color color, String imageUrl, BoxConstraints constraints, int cols, PulsThemeColors t) {
    final isMobile = constraints.maxWidth < 600;
    final spacing = isMobile ? 12.0 : 20.0;
    return SizedBox(
      width: (constraints.maxWidth - (cols - 1) * spacing) / cols,
      child: GlassCard(
        radius: 18,
        blur: 10,
        fillAlpha: 0.05,
        borderAlpha: 0.12,
        padding: EdgeInsets.all(isMobile ? 12 : 24),
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Row(
              children: [
                Expanded(
                  child: Text(
                    value,
                    style: TextStyle(
                      color: color,
                      fontSize: isMobile ? 22 : 36,
                      fontWeight: FontWeight.w800,
                      letterSpacing: -1,
                      fontFeatures: const [FontFeature.tabularFigures()],
                    ),
                  ),
                ),
                Image.network(proxifyImageUrl(imageUrl),
                  width: isMobile ? 32 : 48,
                  height: isMobile ? 32 : 48,
                  cacheHeight: 96,
                  fit: BoxFit.contain,
                  errorBuilder: (context, error, stackTrace) => const SizedBox.shrink(),
                ),
              ],
            ),
            const SizedBox(height: 12),
            Text(label, style: TextStyle(color: t.text, fontSize: isMobile ? 13 : 15, fontWeight: FontWeight.w700)),
            const SizedBox(height: 4),
            Text(sub, style: TextStyle(color: t.textMuted, fontSize: isMobile ? 10 : 12, height: 1.4)),
          ],
        ),
      ),
    );
  }
}

class _CopyButton extends StatefulWidget {
  const _CopyButton({required this.text});
  final String text;

  @override
  State<_CopyButton> createState() => _CopyButtonState();
}

class _CopyButtonState extends State<_CopyButton> {
  bool _copied = false;

  @override
  Widget build(BuildContext context) {
    final t = context.puls;
    return IconButton(
      onPressed: () {
        Clipboard.setData(ClipboardData(text: widget.text));
        setState(() => _copied = true);
        Future.delayed(const Duration(seconds: 2), () {
          if (mounted) setState(() => _copied = false);
        });
        PulsSnack.show(context, 'Address copied to clipboard!');
      },
      icon: Icon(
        _copied ? Icons.check_circle_outline_rounded : Icons.copy_rounded,
        color: _copied ? t.yes : t.brand,
        size: 18,
      ),
      tooltip: 'Copy contract address',
    );
  }
}

// ── Final CTA ─────────────────────────────────────────────────────────────────
class _FinalCtaSection extends StatelessWidget {
  const _FinalCtaSection();

  @override
  Widget build(BuildContext context) {
    final appState = PulsStateScope.of(context);
    final t = context.puls;
    final w = MediaQuery.sizeOf(context).width;
    final isMobile = w < 700;
    final double titleSize = w < 480 ? 38 : (w < 900 ? 52 : 66);

    return Container(
      padding: EdgeInsets.symmetric(horizontal: isMobile ? 20 : 48, vertical: isMobile ? 72 : 130),
      child: Column(
        children: [
          Text(
            'Don\'t trust predictions.',
            textAlign: TextAlign.center,
            style: TextStyle(
              fontFamily: PulsColors.fontDisplay,
              color: t.text,
              fontSize: titleSize,
              fontWeight: FontWeight.w600,
              height: 1.08,
              letterSpacing: -1.5,
            ),
          ),
          Text(
            'Verify them on-chain.',
            textAlign: TextAlign.center,
            style: TextStyle(
              fontFamily: PulsColors.fontDisplay,
              color: t.brand,
              fontSize: titleSize,
              fontWeight: FontWeight.w600,
              fontStyle: FontStyle.italic,
              height: 1.12,
              letterSpacing: -1.5,
            ),
          ),
          const SizedBox(height: 18),
          Text(
            'Trade alongside AI agents that stake real USDC on every call. '
            'One-tap wallet — you\'re trading in under a minute.',
            textAlign: TextAlign.center,
            style: TextStyle(color: t.textMuted, fontSize: isMobile ? 14 : 16, height: 1.6),
          ),
          SizedBox(height: isMobile ? 28 : 36),
          Wrap(
            spacing: 12,
            runSpacing: 12,
            alignment: WrapAlignment.center,
            children: [
              Builder(builder: (context) {
                final wallet = WalletServiceScope.of(context);
                return _PrimaryButton(
                  label: wallet.state.isLoading ? 'Connecting…' : 'Launch Puls',
                  onTap: wallet.state.isLoading
                      ? null
                      : () {
                          if (wallet.state.userId != null) {
                            appState.dismissWebLanding();
                          } else {
                            wallet.signInWithGoogle();
                          }
                        },
                );
              }),
              _SecondaryButton(
                label: '⤓  Android APK',
                onTap: () => launchUrl(Uri.parse(kAndroidApkUrl), mode: LaunchMode.externalApplication),
              ),
            ],
          ),
        ],
      ),
    );
  }
}

// ── Aurora background painter ─────────────────────────────────────────────────
class _AuroraPainter extends CustomPainter {
  const _AuroraPainter({
    required this.progress,
    required this.isDark,
    required this.bg,
    this.pointer = Offset.zero,
  });
  final double progress;
  final bool isDark;
  final Color bg;
  final Offset pointer;

  @override
  void paint(Canvas canvas, Size size) {
    final t = progress * 2 * math.pi;
    final blobs = isDark
        ? const [
            PulsColors.brandWashDark, // Deep plum
            PulsColors.brandPinkDark, // Neon Pink
            PulsColors.brandMint,     // Neon Mint
          ]
        : const [
            PulsColors.brandWashLight, // Frosted pink
            Color(0xFFFDF2F8),         // Soft glow
            Color(0xFFE6FAF6),         // Frosted mint
          ];
    final alpha = isDark ? 0.16 : 0.35;

    canvas.drawRect(Offset.zero & size, Paint()..color = bg);

    void blob(Color c, double cx, double cy, double r) {
      final paint = Paint()
        ..shader = RadialGradient(
          colors: [c.withValues(alpha: alpha), c.withValues(alpha: 0.0)],
        ).createShader(Rect.fromCircle(center: Offset(cx, cy), radius: r));
      canvas.drawCircle(Offset(cx, cy), r, paint);
    }

    final w = size.width, h = size.height;
    // Parallax toward the cursor — each blob drifts a different amount for depth.
    final px = pointer.dx, py = pointer.dy;
    blob(blobs[0], w * (0.28 + 0.06 * math.sin(t)) + px * 150, h * (0.18 + 0.05 * math.cos(t * 0.8)) + py * 120, w * 0.42);
    blob(blobs[1], w * (0.78 + 0.05 * math.cos(t * 0.9)) - px * 120, h * (0.30 + 0.06 * math.sin(t * 0.7)) + py * 90, w * 0.38);
    blob(blobs[2], w * (0.55 + 0.07 * math.sin(t * 0.6 + 2)) + px * 80, h * (0.74 + 0.04 * math.cos(t + 1)) - py * 110, w * 0.34);
  }

  @override
  bool shouldRepaint(_AuroraPainter old) =>
      old.progress != progress || old.isDark != isDark || old.bg != bg || old.pointer != pointer;
}

// ── Film grain overlay ────────────────────────────────────────────────────────
/// A faint, static noise field that adds texture/depth without hurting text
/// crispness (it sits beneath the content). Cheap: a fixed sparse dot field.
class _GrainPainter extends CustomPainter {
  const _GrainPainter({required this.color});
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final rnd = math.Random(42); // deterministic — never shimmers
    final paint = Paint()..color = color;
    final count = (size.width * size.height / 900).clamp(0, 1400).toInt();
    for (var i = 0; i < count; i++) {
      final dx = rnd.nextDouble() * size.width;
      final dy = rnd.nextDouble() * size.height;
      canvas.drawCircle(Offset(dx, dy), 0.6, paint);
    }
  }

  @override
  bool shouldRepaint(_GrainPainter old) => old.color != color;
}

// ── Footer ────────────────────────────────────────────────────────────────────
class _FooterSection extends StatelessWidget {
  const _FooterSection();

  @override
  Widget build(BuildContext context) {
    final t = context.puls;
    final w = MediaQuery.sizeOf(context).width;
    final isMobile = w < 600;

    return Container(
      color: t.surface.withValues(alpha: 0.3),
      padding: EdgeInsets.symmetric(horizontal: isMobile ? 16 : 48, vertical: isMobile ? 48 : 80),
      child: Center(
        child: ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 960),
          child: Column(
            children: [
              isMobile
                  ? Column(
                      children: [
                        Row(
                          mainAxisAlignment: MainAxisAlignment.center,
                          children: [
                            Container(
                              width: 26, height: 26,
                              decoration: BoxDecoration(
                                color: t.brandSubtle,
                                borderRadius: BorderRadius.circular(6),
                              ),
                              clipBehavior: Clip.antiAlias,
                              child: Image.asset('assets/logo.png', fit: BoxFit.cover),
                            ),
                            const SizedBox(width: 10),
                            Text(
                              'Puls',
                              style: TextStyle(fontFamily: PulsColors.fontDisplay, color: t.text, fontSize: 17, fontWeight: FontWeight.w700),
                            ),
                          ],
                        ),
                        const SizedBox(height: 16),
                        Text(
                          '© 2026 Puls · Built on Arc Network',
                          textAlign: TextAlign.center,
                          style: TextStyle(color: t.textSubtle, fontSize: 12, fontWeight: FontWeight.w500),
                        ),
                        const SizedBox(height: 6),
                        Text(
                          'Arc is a trademark of Circle Internet Group, Inc. and/or its affiliates.',
                          textAlign: TextAlign.center,
                          style: TextStyle(color: t.textSubtle.withValues(alpha: 0.5), fontSize: 10, height: 1.4),
                        ),
                        const SizedBox(height: 16),
                        const Wrap(
                          alignment: WrapAlignment.center,
                          spacing: 20,
                          runSpacing: 10,
                          children: [
                            _FooterLink('X/Twitter', 'https://x.com/rdmnad'),
                            _FooterLink('Docs', 'https://docs.pulsmarket.tech'),
                            _FooterLink('GitHub', 'https://github.com/rdmbtc/Puls'),
                            _FooterLink('Explorer', 'https://testnet.arcscan.app/address/$factoryAddress'),
                            _FooterLink('Android app', kAndroidApkUrl),
                            _FooterLink('Terms', 'https://pulsmarket.tech/terms'),
                            _FooterLink('Privacy', 'https://pulsmarket.tech/privacy'),
                          ],
                        ),
                      ],
                    )
                  : Row(
                      children: [
                        Container(
                          width: 26, height: 26,
                          decoration: BoxDecoration(
                            color: t.brandSubtle,
                            borderRadius: BorderRadius.circular(6),
                          ),
                          clipBehavior: Clip.antiAlias,
                          child: Image.asset('assets/logo.png', fit: BoxFit.cover),
                        ),
                        const SizedBox(width: 10),
                        Text(
                          'Puls',
                          style: TextStyle(fontFamily: PulsColors.fontDisplay, color: t.text, fontSize: 17, fontWeight: FontWeight.w700),
                        ),
                        const Spacer(),
                        Column(
                          mainAxisSize: MainAxisSize.min,
                          crossAxisAlignment: CrossAxisAlignment.center,
                          children: [
                            Text(
                              '© 2026 Puls · Built on Arc Network',
                              style: TextStyle(color: t.textSubtle, fontSize: 12, fontWeight: FontWeight.w500),
                            ),
                            const SizedBox(height: 4),
                            Text(
                              'Arc is a trademark of Circle Internet Group, Inc. and/or its affiliates.',
                              style: TextStyle(color: t.textSubtle.withValues(alpha: 0.5), fontSize: 10),
                            ),
                          ],
                        ),
                        const Spacer(),
                        const _FooterLink('X/Twitter', 'https://x.com/rdmnad'),
                        const SizedBox(width: 20),
                        const _FooterLink('Docs', 'https://docs.pulsmarket.tech'),
                        const SizedBox(width: 20),
                        const _FooterLink('GitHub', 'https://github.com/rdmbtc/Puls'),
                        const SizedBox(width: 20),
                        const _FooterLink('Terms', 'https://pulsmarket.tech/terms'),
                        const SizedBox(width: 20),
                        const _FooterLink('Privacy', 'https://pulsmarket.tech/privacy'),
                      ],
                    ),
            ],
          ),
        ),
      ),
    );
  }
}

class _VerifiedBadge extends StatelessWidget {
  const _VerifiedBadge();

  @override
  Widget build(BuildContext context) {
    const green = Color(0xFF16A34A);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 3),
      decoration: BoxDecoration(
        color: green.withValues(alpha: 0.10),
        borderRadius: BorderRadius.circular(999),
        border: Border.all(color: green.withValues(alpha: 0.30)),
      ),
      child: const Row(
        mainAxisSize: MainAxisSize.min,
        children: [
          Icon(Icons.verified_rounded, size: 12, color: green),
          SizedBox(width: 4),
          Text(
            'Verified on Arc',
            style: TextStyle(color: green, fontSize: 11, fontWeight: FontWeight.w600),
          ),
        ],
      ),
    );
  }
}

class _FooterLink extends StatelessWidget {
  const _FooterLink(this.label, this.url);
  final String label, url;

  @override
  Widget build(BuildContext context) {
    final t = context.puls;
    return GestureDetector(
      onTap: () => launchUrl(Uri.parse(url), mode: LaunchMode.externalApplication),
      child: MouseRegion(
        cursor: SystemMouseCursors.click,
        child: Text(
          label,
          style: TextStyle(color: t.textMuted, fontSize: 13, fontWeight: FontWeight.w500),
        ),
      ),
    );
  }
}

// ── Shared Buttons ────────────────────────────────────────────────────────────
class _PrimaryButton extends StatefulWidget {
  const _PrimaryButton({required this.label, required this.onTap, this.small = false});
  final String label;
  final VoidCallback? onTap;
  final bool small;

  @override
  State<_PrimaryButton> createState() => _PrimaryButtonState();
}

class _PrimaryButtonState extends State<_PrimaryButton> {
  bool _hovered = false;
  Offset _magnet = Offset.zero;

  void _onHover(PointerHoverEvent e) {
    if (context.reduceMotion) return;
    final box = context.findRenderObject() as RenderBox?;
    if (box == null || !box.hasSize) return;
    final s = box.size;
    final dx = (e.localPosition.dx - s.width / 2) / (s.width / 2);
    final dy = (e.localPosition.dy - s.height / 2) / (s.height / 2);
    setState(() => _magnet = Offset(dx.clamp(-1.0, 1.0) * 6, dy.clamp(-1.0, 1.0) * 5));
  }

  @override
  Widget build(BuildContext context) {
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hovered = true),
      onHover: _onHover,
      onExit: (_) => setState(() {
        _hovered = false;
        _magnet = Offset.zero;
      }),
      child: GestureDetector(
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 90),
          curve: Curves.easeOut,
          transformAlignment: Alignment.center,
          transform: Matrix4.translationValues(_magnet.dx, _magnet.dy, 0),
          child: AnimatedScale(
            scale: _hovered ? 1.04 : 1.0,
            duration: const Duration(milliseconds: 150),
            child: Container(
              padding: EdgeInsets.symmetric(
                horizontal: widget.small ? 18 : 32,
                vertical: widget.small ? 10 : 16,
              ),
              decoration: BoxDecoration(
                gradient: PulsColors.pulseGradient,
                borderRadius: BorderRadius.circular(12),
                boxShadow: _hovered
                    ? [BoxShadow(color: PulsColors.brandPink.withValues(alpha: 0.35), blurRadius: 20, offset: const Offset(0, 4))]
                    : [],
              ),
              child: Text(
                widget.label,
                style: const TextStyle(
                  color: Colors.white,
                  fontSize: 14,
                  fontWeight: FontWeight.w700,
                ),
              ),
            ),
          ),
        ),
      ),
    );
  }
}

class _SecondaryButton extends StatefulWidget {
  const _SecondaryButton({required this.label, required this.onTap, this.small = false});
  final String label;
  final VoidCallback onTap;
  final bool small;

  @override
  State<_SecondaryButton> createState() => _SecondaryButtonState();
}

class _SecondaryButtonState extends State<_SecondaryButton> {
  bool _hovered = false;

  @override
  Widget build(BuildContext context) {
    final t = context.puls;
    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: GestureDetector(
        onTap: widget.onTap,
        child: AnimatedContainer(
          duration: const Duration(milliseconds: 150),
          padding: EdgeInsets.symmetric(
            horizontal: widget.small ? 16 : 30,
            vertical: widget.small ? 10 : 16,
          ),
          decoration: BoxDecoration(
            color: _hovered ? t.surfaceRaised : t.surface,
            borderRadius: BorderRadius.circular(12),
            border: Border.all(color: _hovered ? t.textMuted : t.border),
          ),
          child: Text(
            widget.label,
            style: TextStyle(
              color: _hovered ? t.text : t.textMuted,
              fontSize: 14,
              fontWeight: FontWeight.w600,
            ),
          ),
        ),
      ),
    );
  }
}

class _DotGridPainter extends CustomPainter {
  const _DotGridPainter({required this.color});
  final Color color;

  @override
  void paint(Canvas canvas, Size size) {
    final paint = Paint()..color = color;
    const spacing = 32.0;
    for (double x = 0; x < size.width; x += spacing) {
      for (double y = 0; y < size.height; y += spacing) {
        canvas.drawCircle(Offset(x, y), 0.75, paint);
      }
    }
  }

  @override
  bool shouldRepaint(_DotGridPainter old) => old.color != color;
}

// ── Scroll reveal ─────────────────────────────────────────────────────────────
/// Fades + slides its child in the first time it scrolls into view.
class _Reveal extends StatefulWidget {
  const _Reveal({required this.scrollOffset, required this.child});
  final double scrollOffset;
  final Widget child;

  @override
  State<_Reveal> createState() => _RevealState();
}

class _RevealState extends State<_Reveal> {
  bool _shown = false;
  double? _top;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted || _shown) return;
      _measure();
      final h = MediaQuery.sizeOf(context).height;
      final top = _top;
      if (top != null && widget.scrollOffset + h * 0.88 > top) {
        setState(() => _shown = true);
      } else {
        setState(() {}); // re-render with measured position
      }
    });
  }

  @override
  void didUpdateWidget(covariant _Reveal old) {
    super.didUpdateWidget(old);
    if (_shown) return;
    _measure();
    final h = MediaQuery.sizeOf(context).height;
    final top = _top;
    if (top != null && widget.scrollOffset + h * 0.88 > top) {
      setState(() => _shown = true);
    }
  }

  void _measure() {
    final box = context.findRenderObject() as RenderBox?;
    if (box == null || !box.attached || !box.hasSize) return;
    // Global position + current scroll offset = position in scroll content.
    _top = box.localToGlobal(Offset.zero).dy + widget.scrollOffset;
  }

  @override
  Widget build(BuildContext context) {
    // Anything starting within the first viewport shows immediately.
    final h = MediaQuery.sizeOf(context).height;
    // Reduce-motion: reveal everything at once, with no fade/slide ramp.
    final reduce = context.reduceMotion;
    final visibleNow = reduce || _shown || (_top != null && _top! < h * 0.92);
    final revealDuration = context.motionDuration(const Duration(milliseconds: 650));
    return AnimatedOpacity(
      duration: revealDuration,
      curve: Curves.easeOut,
      opacity: _shown || visibleNow ? 1 : 0,
      child: AnimatedSlide(
        duration: revealDuration,
        curve: Curves.easeOutCubic,
        offset: _shown || visibleNow ? Offset.zero : const Offset(0, 0.045),
        child: widget.child,
      ),
    );
  }
}

// ── Scroll cue ────────────────────────────────────────────────────────────────
class _ScrollCue extends StatefulWidget {
  const _ScrollCue();

  @override
  State<_ScrollCue> createState() => _ScrollCueState();
}

class _ScrollCueState extends State<_ScrollCue>
    with SingleTickerProviderStateMixin {
  late final AnimationController _c;

  @override
  void initState() {
    super.initState();
    _c = AnimationController(vsync: this, duration: const Duration(milliseconds: 1400));
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final t = context.puls;
    final reduce = context.reduceMotion;
    if (reduce) {
      if (_c.isAnimating) _c.stop();
    } else if (!_c.isAnimating) {
      _c.repeat(reverse: true);
    }
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(
          'SCROLL',
          style: TextStyle(
            color: t.textSubtle,
            fontSize: 9.5,
            fontWeight: FontWeight.w800,
            letterSpacing: 2,
          ),
        ),
        const SizedBox(height: 6),
        AnimatedBuilder(
          animation: _c,
          builder: (context, child) => Transform.translate(
            offset: Offset(0, reduce ? 0 : _c.value * 5),
            child: child,
          ),
          child: Container(
            width: 26,
            height: 26,
            alignment: Alignment.center,
            decoration: BoxDecoration(
              color: t.surface,
              shape: BoxShape.circle,
              border: Border.all(color: t.border),
            ),
            child: Icon(Icons.keyboard_arrow_down_rounded, size: 18, color: t.textMuted),
          ),
        ),
      ],
    );
  }
}

// ── Visual · Puls Gateway (x402) ───────────────────────────────────────────────
class _GatewayViz extends StatefulWidget {
  const _GatewayViz();
  @override
  State<_GatewayViz> createState() => _GatewayVizState();
}

class _GatewayVizState extends State<_GatewayViz> with SingleTickerProviderStateMixin {
  late final AnimationController _c;

  @override
  void initState() {
    super.initState();
    _c = AnimationController(vsync: this, duration: const Duration(seconds: 4));
  }

  @override
  void dispose() {
    _c.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    final reduce = context.reduceMotion;
    if (reduce) {
      if (_c.isAnimating) _c.stop();
    } else if (!_c.isAnimating) {
      _c.repeat();
    }
    final t = context.puls;
    return RepaintBoundary(
      child: AnimatedBuilder(
        animation: _c,
        builder: (context, _) {
        final v = reduce ? 0.8 : _c.value;
        final phase = v < 0.33 ? 0 : (v < 0.66 ? 1 : 2); // 0: Query, 1: Pay, 2: Data
        
        return Column(
          mainAxisAlignment: MainAxisAlignment.center,
          children: [
            Row(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                _node(t, phase == 0, Icons.smart_toy_rounded, 'Agent'),
                _line(t, phase == 1, 'x402 Pay'),
                _node(t, phase == 2, Icons.cloud_download_rounded, 'Premium API'),
              ],
            ),
            const SizedBox(height: 16),
            Text(
              phase == 0 ? 'Evaluating ROI...' : (phase == 1 ? 'Settling 0.000005 USDC' : 'Data Unlocked'),
               style: TextStyle(color: t.textSubtle, fontSize: 10, fontWeight: FontWeight.w700),
            )
          ],
        );
      },
    ),
    );
  }

  Widget _node(PulsThemeColors t, bool active, IconData icon, String label) {
     return Column(
       mainAxisSize: MainAxisSize.min,
       children: [
         AnimatedContainer(
           duration: const Duration(milliseconds: 300),
           padding: const EdgeInsets.all(12),
           decoration: BoxDecoration(
             color: active ? t.brand.withValues(alpha: 0.2) : t.surfaceRaised,
             shape: BoxShape.circle,
             border: Border.all(color: active ? t.brand : t.border)
           ),
           child: Icon(icon, size: 18, color: active ? t.brand : t.textMuted),
         ),
         const SizedBox(height: 6),
         Text(label, style: TextStyle(color: t.textMuted, fontSize: 9, fontWeight: FontWeight.w800)),
       ]
     );
  }

  Widget _line(PulsThemeColors t, bool active, String label) {
    return Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        Text(label, style: TextStyle(color: active ? t.yes : Colors.transparent, fontSize: 8, fontWeight: FontWeight.w900)),
        Container(
          width: 40,
          height: 2,
          margin: const EdgeInsets.symmetric(horizontal: 8, vertical: 4),
          color: active ? t.yes : t.border,
        ),
      ],
    );
  }
}
