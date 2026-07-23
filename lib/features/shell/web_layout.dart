import 'package:flutter/material.dart';

/// Constrains content to a readable max-width and centers it on wide screens.
class WebLayout extends StatelessWidget {
  const WebLayout({required this.child, this.maxWidth = 900, super.key});

  final Widget child;
  final double maxWidth;

  @override
  Widget build(BuildContext context) {
    return Align(
      alignment: Alignment.topCenter,
      child: ConstrainedBox(
        constraints: BoxConstraints(maxWidth: maxWidth),
        child: child,
      ),
    );
  }
}
