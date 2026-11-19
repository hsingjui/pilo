import { reduceMotion, split, View, type ViewProps } from "nsh";
import { classNames } from "./class-names";
import { SkeletonShimmer } from "./skeleton-shimmer";

export interface SkeletonProps extends ViewProps {
	strong?: boolean;
}

export function Skeleton(props: SkeletonProps) {
	const [local, rest] = split(props, ["class", "strong", "children"]);
	return (
		<View
			{...rest}
			class={classNames(
				"relative overflow-hidden rounded-(--pilo-radius-md)",
				local.strong ? "bg-skeleton-line-strong" : "bg-skeleton-line",
				local.class,
			)}
			accessible={false}
			accessibilityElementsHidden
		>
			{local.children}
			{() => (reduceMotion() ? null : <SkeletonShimmer />)}
		</View>
	);
}
