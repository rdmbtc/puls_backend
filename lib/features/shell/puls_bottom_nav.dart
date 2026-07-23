import 'package:flutter/material.dart';
import 'package:picons/picons.dart';

import '../../core/motion.dart';
import '../../core/theme/app_theme.dart';

/// The signature Puls bottom navigation: a floating "dynamic island" bar with a
/// single gradient pill that *glides* between tabs (with a gentle spring
/// overshoot), an icon micro-bounce on the active tab, web hover highlights and
/// a reduce-motion fallback that snaps instantly.
///
/// Pure presentation — the parent owns [index] and reacts to [onTap] (which is
/// also fired when the already-active tab is tapped, so callers can refresh).
class PulsBottomNav extends StatelessWidget {
  const PulsBottomNav({
    required this.index,
    required this.isDark,
    required this.onTap,
    required this.browseLabel,
    required this.browseIcon,
    super.key,
  });

  final int index;
  final bool isDark;
  final ValueChanged<int> onTap;

  /// The label + icon shown on the Browse cell (cell 0), reflecting whichever
  /// browse surface (Feed / Discover / Home) is currently active.
  final String browseLabel;
  final PiconData browseIcon;

  /// Icons for the three browse surfaces, in order: Feed, Discover, Home.
  static final browseIcons = <PiconData>[
    Picons.lightning,
    Picons.compass,
    Picons.playCircle,
  ];

  // Fixed destinations after the Browse cell.
  static final _fixedItems = <PulsNavItem>[
    PulsNavItem(Picons.chartBar, 'Portfolio'),
    PulsNavItem(Picons.star, 'Creators'),
    PulsNavItem(Picons.robot, 'Agent'),
    PulsNavItem(Picons.userCircle, 'Profile'),
  ];

  // The full 5-cell item list (Browse + 4 fixed), rebuilt per render so the
  // Browse cell reflects the active surface.
  List<PulsNavItem> get _items => [
        PulsNavItem(browseIcon, browseLabel, isBrowse: true),
        ..._fixedItems,
      ];

  // Inset of the gliding pill within each tab cell.
  static const double _pillH = 4;
  static const double _pillV = 8;
  static const double _barH = 64;

  @override
  Widget build(BuildContext context) {
    final bg = isDark ? const Color(0xFF0E1322) : const Color(0xFFFFFFFF);
    final shadow = isDark
        ? const Color(0xFFEC4899).withValues(alpha: 0.3)
        : const Color(0xFFEC4899).withValues(alpha: 0.08);

    // Honour the OS "reduce motion" setting — glide instantly when requested.
    final reduceMotion = context.reduceMotion;
    final glideDuration =
        context.motionDuration(const Duration(milliseconds: 340));

    return SafeArea(
      child: Padding(
        padding: const EdgeInsets.fromLTRB(24, 0, 24, 12),
        child: Container(
          height: _barH,
          decoration: BoxDecoration(
            color: bg,
            borderRadius: BorderRadius.circular(32),
            boxShadow: [
              BoxShadow(
                color: shadow,
                blurRadius: 24,
                offset: const Offset(0, 8),
              ),
              BoxShadow(
                color: shadow.withValues(alpha: 0.06),
                blurRadius: 4,
                offset: const Offset(0, 2),
              ),
            ],
          ),
          child: LayoutBuilder(
            builder: (context, constraints) {
              final items = _items;
              final cellW = constraints.maxWidth / items.length;
              final pillW = cellW - _pillH * 2;
              final pillLeft = index * cellW + _pillH;

              return Stack(
                children: [
                  // The single gradient pill that glides under the active tab.
                  AnimatedPositioned(
                    duration: glideDuration,
                    // A gentle overshoot makes the glide feel springy and alive.
                    curve: reduceMotion ? Curves.linear : Curves.easeOutBack,
                    left: pillLeft,
                    top: _pillV,
                    width: pillW,
                    height: _barH - _pillV * 2,
                    child: DecoratedBox(
                      decoration: BoxDecoration(
                        gradient: PulsColors.pulseGradient,
                        borderRadius: BorderRadius.circular(24),
                        boxShadow: [
                          BoxShadow(
                            color: PulsColors.brandPink.withValues(alpha: 0.35),
                            blurRadius: 16,
                            offset: const Offset(0, 6),
                          ),
                        ],
                      ),
                    ),
                  ),
                  // Tappable tab cells sit on top of the pill.
                  Row(
                    children: List.generate(items.length, (i) {
                      return Expanded(
                        child: _NavCell(
                          item: items[i],
                          selected: i == index,
                          isDark: isDark,
                          onTap: () => onTap(i),
                        ),
                      );
                    }),
                  ),
                ],
              );
            },
          ),
        ),
      ),
    );
  }
}

/// A single tab cell: icon + label with a press-scale, a web hover highlight,
/// and colours that animate as selection moves between tabs.
class _NavCell extends StatefulWidget {
  const _NavCell({
    required this.item,
    required this.selected,
    required this.isDark,
    required this.onTap,
  });

  final PulsNavItem item;
  final bool selected;
  final bool isDark;
  final VoidCallback onTap;

  @override
  State<_NavCell> createState() => _NavCellState();
}

class _NavCellState extends State<_NavCell> {
  bool _hovered = false;
  double _scale = 1.0;

  @override
  Widget build(BuildContext context) {
    final selected = widget.selected;
    final isDark = widget.isDark;
    final colorDuration =
        context.motionDuration(const Duration(milliseconds: 220));

    final restIcon = isDark ? const Color(0xFF8181AA) : const Color(0xFF9A9A94);
    final restLabel = isDark ? const Color(0xFF6565A0) : const Color(0xFFB0B0C0);
    const hoverTint = PulsColors.brandPink;

    final iconColor =
        selected ? Colors.white : (_hovered ? hoverTint : restIcon);
    final labelColor =
        selected ? Colors.white : (_hovered ? hoverTint : restLabel);

    return MouseRegion(
      cursor: SystemMouseCursors.click,
      onEnter: (_) => setState(() => _hovered = true),
      onExit: (_) => setState(() => _hovered = false),
      child: Semantics(
        // Announce the tab as a button with its label + selected state, so
        // screen-reader users get the same context sighted users get from
        // the gradient pill (which is purely visual — without this, the
        // icon-only cell on wide screens would be announced as a bare icon
        // with no label, leaving the user unable to navigate by tab).
        button: true,
        selected: selected,
        label: widget.item.label,
        hint: selected
            ? 'Currently on ${widget.item.label} tab'
            : 'Switch to ${widget.item.label} tab',
        excludeSemantics: true,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTapDown: (_) => setState(() => _scale = 0.92),
          onTapUp: (_) => setState(() => _scale = 1.0),
          onTapCancel: () => setState(() => _scale = 1.0),
          onTap: widget.onTap,
          child: AnimatedScale(
            scale: _scale,
            duration: const Duration(milliseconds: 100),
            curve: Curves.easeOutCubic,
            child: Column(
              mainAxisAlignment: MainAxisAlignment.center,
              children: [
                AnimatedScale(
                  scale: selected ? 1.12 : 1.0,
                  duration: colorDuration,
                  curve: Curves.easeOutBack,
                  child: widget.item.isBrowse
                      ? Row(
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Picon(widget.item.icon, size: 20, color: iconColor),
                            const SizedBox(width: 2),
                            Icon(Icons.keyboard_arrow_down_rounded, size: 13, color: iconColor),
                          ],
                        )
                      : Picon(
                          widget.item.icon,
                          size: 20,
                          color: iconColor,
                        ),
                ),
                const SizedBox(height: 2),
                AnimatedDefaultTextStyle(
                  duration: colorDuration,
                  style: TextStyle(
                    fontSize: 9,
                    fontWeight: selected ? FontWeight.w700 : FontWeight.w400,
                    color: labelColor,
                  ),
                  child: Text(widget.item.label),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class PulsNavItem {
  const PulsNavItem(this.icon, this.label, {this.isBrowse = false});
  final PiconData icon;
  final String label;
  final bool isBrowse;
}
