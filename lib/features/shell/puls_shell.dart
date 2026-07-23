import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../../core/theme/app_theme.dart';
import '../../core/widgets/lazy_indexed_stack.dart';
import '../../core/widgets/puls_sheet.dart';
import '../discover/discover_screen.dart';
import '../feed/feed_screen.dart';
import '../home/home_screen.dart';
import 'puls_bottom_nav.dart';
import '../portfolio/portfolio_screen.dart';
import '../profile/profile_screen.dart';
import '../profile/leaderboard_screen.dart';
import '../agent/agent_screen.dart';
import '../onboarding/onboarding_sheet.dart';
import 'shell_nav.dart';
import 'web_shell.dart';

class PulsShell extends StatelessWidget {
  const PulsShell({super.key});

  @override
  Widget build(BuildContext context) {
    // On web: use mobile shell for narrow screens (phones/PWA), desktop shell for wide
    if (kIsWeb) {
      final width = MediaQuery.sizeOf(context).width;
      if (width < 600) return const _MobileShell();
      return const WebShell();
    }
    return const _MobileShell();
  }
}

class _MobileShell extends StatefulWidget {
  const _MobileShell();

  @override
  State<_MobileShell> createState() => _PulsShellState();
}

class _PulsShellState extends State<_MobileShell> {
  // Nav cell index in the bottom bar (5 cells): 0=Browse, 1=Portfolio,
  // 2=Creators, 3=Agent, 4=Profile.
  int _index = 0;
  // Which browse surface is active inside the Browse cell: 0=Feed, 1=Discover,
  // 2=Home. Lets all three fit on mobile without crowding the dynamic island.
  int _browse = 0;

  @override
  void initState() {
    super.initState();
    maybeShowWelcome(this);
  }

  // The Browse cell swaps between these three surfaces via a dropdown.
  static const _browsePages = [
    FeedScreen(),
    DiscoverScreen(),
    HomeScreen(),
  ];
  static const _browseLabels = ['Feed', 'Discover', 'Home'];
  // One-line clarifier per browse surface so the three are never confused.
  static const _browseDescs = [
    'Swipe to trade live markets',
    'Browse & search by category',
    'Vertical video feed',
  ];

  // The four fixed destinations after Browse.
  static const _fixedPages = [
    PortfolioScreen(),
    LeaderboardScreen(),
    AgentScreen(),
    ProfileScreen(),
  ];

  // Map shell-independent tab ids → (navIndex, browseIndex?).
  void _goToTab(PulsTab tab) {
    switch (tab) {
      case PulsTab.feed:
        setState(() { _index = 0; _browse = 0; });
        break;
      case PulsTab.discover:
        setState(() { _index = 0; _browse = 1; });
        break;
      case PulsTab.home:
        setState(() { _index = 0; _browse = 2; });
        break;
      case PulsTab.portfolio:
        setState(() => _index = 1);
        break;
      case PulsTab.leaderboard:
        setState(() => _index = 2);
        break;
      case PulsTab.agent:
        setState(() => _index = 3);
        break;
      case PulsTab.profile:
        setState(() => _index = 4);
        break;
    }
  }

  // Open the Browse dropdown to pick Feed / Discover / Home.
  Future<void> _openBrowsePicker() async {
    final t = context.puls;
    final picked = await PulsSheet.show<int>(
      context,
      builder: (_) => PulsSheetSurface(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Padding(
              padding: const EdgeInsets.fromLTRB(4, 0, 4, 8),
              child: Text('Browse', style: TextStyle(color: t.text, fontSize: 18, fontWeight: FontWeight.w900)),
            ),
            for (var i = 0; i < _browsePages.length; i++)
              _BrowseOption(
                icon: PulsBottomNav.browseIcons[i],
                label: _browseLabels[i],
                desc: _browseDescs[i],
                selected: _browse == i,
                t: t,
                onTap: () => Navigator.of(context).pop(i),
              ),
          ],
        ),
      ),
    );
    if (picked != null) setState(() { _index = 0; _browse = picked; });
  }

  void _onNavTap(int i) {
    if (i == 0) {
      // Browse cell: if already here, open the picker; else jump to Browse.
      if (_index == 0) {
        _openBrowsePicker();
      } else {
        setState(() => _index = 0);
        HapticFeedback.selectionClick();
      }
      return;
    }
    if (i == _index) return;
    HapticFeedback.selectionClick();
    setState(() => _index = i);
  }

  @override
  Widget build(BuildContext context) {
    final t = context.puls;
    final isLight = !context.isDark;

    // Stack: [browse surface (swappable)] + the 4 fixed pages.
    final pages = <Widget>[
      LazyIndexedStack(index: _browse, children: _browsePages),
      ..._fixedPages,
    ];

    return ShellNavScope(
      goToTab: _goToTab,
      child: AnnotatedRegion<SystemUiOverlayStyle>(
      value: isLight
          ? SystemUiOverlayStyle.dark.copyWith(statusBarColor: Colors.transparent)
          : SystemUiOverlayStyle.light.copyWith(statusBarColor: Colors.transparent),
      child: Scaffold(
        backgroundColor: t.bg,
        extendBody: true,
        body: LazyIndexedStack(index: _index, children: pages),
        bottomNavigationBar: PulsBottomNav(
          index: _index,
          isDark: !isLight,
          browseLabel: _browseLabels[_browse],
          browseIcon: PulsBottomNav.browseIcons[_browse],
          onTap: _onNavTap,
        ),
      ),
      ),
    );
  }
}

/// One row in the Browse dropdown sheet.
class _BrowseOption extends StatelessWidget {
  const _BrowseOption({
    required this.icon,
    required this.label,
    required this.desc,
    required this.selected,
    required this.t,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final String desc;
  final bool selected;
  final PulsThemeColors t;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    return InkWell(
      onTap: onTap,
      borderRadius: BorderRadius.circular(14),
      child: Container(
        margin: const EdgeInsets.symmetric(vertical: 4),
        padding: const EdgeInsets.symmetric(horizontal: 14, vertical: 14),
        decoration: BoxDecoration(
          color: selected ? t.brand.withValues(alpha: 0.12) : t.surfaceRaised.withValues(alpha: 0.5),
          borderRadius: BorderRadius.circular(14),
          border: Border.all(color: selected ? t.brand.withValues(alpha: 0.4) : t.border),
        ),
        child: Row(children: [
          Icon(icon, size: 20, color: selected ? t.brand : t.textMuted),
          const SizedBox(width: 12),
          Expanded(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              mainAxisSize: MainAxisSize.min,
              children: [
                Text(label, style: TextStyle(color: selected ? t.brand : t.text, fontSize: 15, fontWeight: FontWeight.w700)),
                const SizedBox(height: 2),
                Text(desc, style: TextStyle(color: t.textMuted, fontSize: 12, fontWeight: FontWeight.w500)),
              ],
            ),
          ),
          if (selected) Icon(Icons.check_rounded, size: 18, color: t.brand),
        ]),
      ),
    );
  }
}
