import 'package:flutter/widgets.dart';

/// Stable, shell-independent identifiers for the primary navigation
/// destinations. Each shell (mobile vs. web) maps these to its own tab index,
/// so descendant widgets can request a tab switch without knowing the concrete
/// index — which differs between shells.
enum PulsTab { feed, discover, home, portfolio, leaderboard, agent, profile }

/// Lets descendant widgets switch the active shell tab while keeping the
/// navigation menu visible. Use this instead of pushing a full-screen route
/// (e.g. `Navigator.push(AgentScreen())`), which hides the shell + menu.
class ShellNavScope extends InheritedWidget {
  const ShellNavScope({
    super.key,
    required this.goToTab,
    required super.child,
  });

  final void Function(PulsTab tab) goToTab;

  static ShellNavScope? maybeOf(BuildContext context) =>
      context.dependOnInheritedWidgetOfExactType<ShellNavScope>();

  static ShellNavScope of(BuildContext context) {
    final scope = maybeOf(context);
    assert(scope != null, 'ShellNavScope not found in context');
    return scope!;
  }

  @override
  bool updateShouldNotify(ShellNavScope oldWidget) =>
      goToTab != oldWidget.goToTab;
}
